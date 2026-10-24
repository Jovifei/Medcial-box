import test from 'node:test';
import assert from 'node:assert/strict';
import {applyMigrations} from '../dist/db/migrations.js';
import {buildServer} from '../dist/app.js';
import {createTestGateway} from './helpers/fake-wechat.mjs';
import {contend, isolatedPostgres} from './helpers/isolated-pg.mjs';

const url = process.env.TEST_DATABASE_URL;
for (const operation of ['invitation replay', 'family switch']) {
  test(`real PG: ${operation} and leave share a consistent family/member/session lock order`, {
    skip: !url && process.env.REQUIRE_POSTGRES_TESTS !== '1',
  }, async () => {
    assert.ok(url, 'strict PostgreSQL resource required');
    const fixture = await isolatedPostgres(url);
    const {pool, database} = fixture;
    let app;
    try {
      await applyMigrations(pool);
      app = await buildServer({
        database,
        wechatGateway: createTestGateway({owner: 'synthetic-lock-owner', member: 'synthetic-lock-member'}),
        logger: false,
      });
      const expect = (response, status) => {
        assert.equal(response.statusCode, status, response.body);
        return status === 204 ? null : response.json();
      };
      const login = async code => expect(await app.inject({
        method: 'POST', url: '/api/v1/auth/wechat', payload: {code},
      }), 200).token;
      const req = (token, path, payload, familyId) => app.inject({
        method: 'POST', url: `/api/v1${path}`, payload,
        headers: {authorization: `Bearer ${token}`, ...(familyId ? {'x-family-id': familyId} : {})},
      });
      const ownerToken = await login('owner');
      const family = expect(await req(ownerToken, '/families', {name: 'Synthetic lock household'}), 201).family;
      const memberToken = await login('member');
      const code = expect(await req(ownerToken, '/families/invitations'), 201).invitationCode;
      const accepted = expect(await req(memberToken, '/families/invitations/accept', {code}), 200);
      const leavingToken = await login('member');
      const users = (await pool.query('SELECT id, openid FROM users')).rows;
      const ownerId = users.find(user => user.openid === 'synthetic-lock-owner').id;
      const memberId = users.find(user => user.openid === 'synthetic-lock-member').id;
      await pool.query('INSERT INTO medicines(family_id,name,created_by,updated_by) VALUES($1,$2,$3,$3)',
        [family.id, 'Untouched synthetic inventory', ownerId]);
      const untouched = async () => ({
        families: (await pool.query('SELECT * FROM families ORDER BY id')).rows,
        inventory: (await pool.query('SELECT * FROM medicines ORDER BY id')).rows,
        owner: (await pool.query('SELECT * FROM family_members WHERE user_id=$1 ORDER BY id', [ownerId])).rows,
        ownerSessions: (await pool.query('SELECT id,active_family_id FROM sessions WHERE user_id=$1 ORDER BY id', [ownerId])).rows,
        invitations: (await pool.query('SELECT id,used_at,used_by FROM family_invites ORDER BY id')).rows,
      });
      const before = await untouched();
      assert.equal(before.invitations[0].used_by, memberId, 'the replay uses an already-consumed invitation');

      // contend holds the leader's actual PostgreSQL row lock and requires
      // pg_blocking_pids to confirm the follower waits before releasing it.
      // Old leave holds sessions first: releasing the leader then makes a real
      // family/session (replay) or member/session (switch) deadlock, not a mock.
      const replay = operation === 'invitation replay';
      const [selected, left] = await contend(
        fixture,
        replay
          ? /SELECT id FROM families WHERE id = \$1 FOR UPDATE/
          : /FROM family_members WHERE user_id = \$1 AND family_id = \$2 FOR (SHARE|UPDATE)/,
        () => replay
          ? req(memberToken, '/families/invitations/accept', {code})
          : req(memberToken, `/families/${family.id}/switch`),
        () => req(leavingToken, '/families/leave', undefined, family.id),
      );
      const result = expect(selected, 200);
      expect(left, 204);
      if (replay) assert.equal(result.membership.id, accepted.membership.id);
      else assert.equal(result.familyId, family.id);
      assert.equal((await pool.query('SELECT id FROM family_members WHERE user_id=$1', [memberId])).rowCount, 0);
      const sessions = (await pool.query('SELECT active_family_id FROM sessions WHERE user_id=$1', [memberId])).rows;
      assert.equal(sessions.length, 2);
      assert.ok(sessions.every(session => session.active_family_id === null), 'neither session may retain the exited household');
      assert.deepEqual(await untouched(), before, 'leave/replay must preserve the household, owner, inventory and invitation receipt');
    } finally {
      if (app) await app.close();
      await fixture.close();
    }
  });
}
