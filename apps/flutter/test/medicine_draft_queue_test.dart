import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/medicine_draft_queue.dart';
void main() {
 test('distinct queues sharing one store preserve concurrent entries', () async {
 final store = MemoryInventoryLocalStore();
 final first = MedicineDraftQueue(store);
 final second = MedicineDraftQueue(store);
 await Future.wait([
 first.save('a', {'name': 'first'}),
 second.save('b', {'name': 'second'}),
 ]);
 expect((await first.list()).map((entry) => entry['id']).toSet(), {'a', 'b'});
 });

 test('concurrent draft writes do not overwrite each other', () async { final queue=MedicineDraftQueue(MemoryInventoryLocalStore()); await Future.wait([queue.save('a',{'name':'a'}),queue.save('b',{'name':'b'})]); expect((await queue.list()).length,2); });
 test('ten drafts preserve stable identities, reject overflow, restore and delete individually', () async {
 final store=MemoryInventoryLocalStore(); final queue=MedicineDraftQueue(store);
 for(var i=0;i<10;i++) { await queue.save('draft-$i',{'name':'name-$i','status':'review'}); }
 expect((await queue.list()).length,10); await expectLater(queue.save('overflow',{'name':'extra'}),throwsStateError);
 await queue.save('draft-3',{'name':'edited','savedMedicineId':'saved'});
 final restored=await MedicineDraftQueue(store).list(); expect(restored.singleWhere((d)=>d['id']=='draft-3')['savedMedicineId'],'saved');
 await queue.remove('draft-3'); expect((await queue.list()).length,9); await queue.save('overflow',{'name':'extra'}); expect((await queue.list()).length,10);
 expect(jsonDecode(store.drafts[MedicineDraftQueue.storageKey]!) is List,true);
 });
}
