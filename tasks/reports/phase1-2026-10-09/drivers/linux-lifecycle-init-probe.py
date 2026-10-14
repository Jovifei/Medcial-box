import pathlib,json,subprocess,uuid,time,datetime
base=pathlib.Path('E:/Claude_allow/Download/medcial_box/phase1-20261008');r=json.loads((base/'private-resources.json').read_text());dbinfo=json.loads(subprocess.check_output(['docker','inspect',r['id']],text=True))[0];assert dbinfo['Name']=='/'+r['name'] and dbinfo['Created']==r['created']
audit=base/'linux-lifecycle-init';audit.mkdir(exist_ok=True);(audit/'preload.mjs').write_bytes((base/'linux-lifecycle/preload.mjs').read_bytes())
name='medbox-phase1-init-'+uuid.uuid4().hex[:12];url='postgresql://'+r['user']+':'+r['password']+'@127.0.0.1:5432/medbox_lifecycle'
run=subprocess.run(['docker','run','-d','--init','--name',name,'--label','medbox.audit=phase1-20261008','--network','container:'+r['id'],'--mount','type=bind,src='+str(base/'checkout')+',dst=/app,readonly','--mount','type=bind,src='+str(audit)+',dst=/audit','--workdir','/app','-e','DATABASE_URL='+url,'-e','API_HOST=127.0.0.1','-e','API_PORT=3000','-e','PRIVATE_UPLOAD_DIR=/tmp/audit-private','node:22-alpine','node','--import=/audit/preload.mjs','apps/api/dist/server.js'],capture_output=True,text=True)
if run.returncode:raise RuntimeError('Owned init runtime creation failed')
id=run.stdout.strip();info=json.loads(subprocess.check_output(['docker','inspect',id],text=True))[0];assert info['Name']=='/'+name and info['Config']['Labels']['medbox.audit']=='phase1-20261008'
result={'source_sha':'85bfe729f2089db2ee48040b450293511e8ce9c7','node_image':info['Image'],'configuration':'init=true matches deploy/docker-compose.staging.yml','scope':'actual production entry+PG; no configured provider/messages; no active-send drain proof','container_id':id}
try:
 for attempt in range(40):
  probe=subprocess.run(['docker','exec',id,'node','-e',"fetch('http://127.0.0.1:3000/api/v1/health/ready').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"],capture_output=True,text=True)
  if probe.returncode==0:result['ready_status']=200;break
  time.sleep(1)
 else:raise RuntimeError('Readiness timeout')
 subprocess.run(['docker','kill','--signal=SIGTERM',id],check=True,capture_output=True)
 try:
  exited=subprocess.run(['docker','wait',id],capture_output=True,text=True,timeout=15);result['process_exit_code']=int(exited.stdout.strip())
 except subprocess.TimeoutExpired:result['process_exit_code']=None;result['timeout_seconds']=15
 result['control']=json.loads((audit/'control.json').read_text());result.update(json.loads((audit/'pool-end.json').read_text()));result['status']='FAIL' if result['poolEndCalls']==0 else 'PASS'
except Exception as e:result.update(status='BLOCKED',error_type=type(e).__name__)
finally:
 current=json.loads(subprocess.check_output(['docker','inspect',id],text=True))[0];assert current['Id']==id and current['Created']==info['Created'] and current['Name']=='/'+name
 subprocess.run(['docker','rm','-f',id],check=True,capture_output=True);result['owned_runtime_removed']=True
result['finished_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();(base/'linux-lifecycle-init-results.json').write_text(json.dumps(result,indent=2),encoding='utf-8');print(json.dumps(result,indent=2))
