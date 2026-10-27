import { prepareSourceProtection, sourceProtectionSnapshot } from './source-protection.js'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { API_VERSION, MemoryError, assertId, assertOnly, digest, failure } from './contracts.js'
import { acquireRootLock } from './transactions.js'
import { MemoryTransfer, packageOwnerArchive, validateTransferArchive } from './transfer.js'
import { MemoryAdministration } from './administration.js'
import { exportPersonaState, personaIdentityProjection, validatePortablePersonaState } from './persona-ledger.js'
import { exportPurgeState } from './purge-ledger.js'
import { listRecordHeads } from './record-integrity.js'
import { loadMaintenanceState } from './lifecycle-ledger.js'
import { loadSelfHead, readSelfFiles, validateSelfFiles, validateSelfHead, verifySelfFiles } from './self-integrity.js'
import { isGrowthSelfPath } from './self-transfer.js'

const ROOTS=['records','evidence','candidates','self','assets','cold','quarantine','external-changes']
const fail=(code)=>{throw new MemoryError(code)}
function inside(parent,child){const rel=relative(parent,child);return rel===''||rel!=='..'&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel)}
function safe(path){let current=resolve(path);while(true){if(existsSync(current)&&lstatSync(current).isSymbolicLink())fail('UNSAFE_STORAGE_PATH');const parent=resolve(current,'..');if(parent===current)return;current=parent}}
function read(path){safe(path);const stat=lstatSync(path);if(!stat.isFile()||stat.nlink!==1||stat.size>16*1024*1024)fail('UNSAFE_UPGRADE_SOURCE');return readFileSync(path)}
function walk(root,prefix,files){const path=join(root,prefix);safe(path);if(!existsSync(path))return;const stat=lstatSync(path);if(stat.isDirectory()){for(const entry of readdirSync(path).sort())walk(root,`${prefix}/${entry}`,files)}else if(stat.isFile()){const data=read(path);files.push({path:prefix,data,size:data.length,sha256:digest(data)});if(files.length>10000||files.reduce((n,file)=>n+file.size,0)>64*1024*1024)fail('UPGRADE_LIMIT_EXCEEDED')}else fail('UNSAFE_UPGRADE_SOURCE')}
function observe(source,space){
 if(existsSync(join(source,'spaces',space,'journal'))&&readdirSync(join(source,'spaces',space,'journal')).length)fail('SOURCE_RECOVERY_REQUIRED')
 const inputs=[]
 for(const path of ['manifest.json','.administration/persona-ledger.json','.administration/purge-ledger.json','.administration/source-protection.json',`.administration/lifecycle/${space}.json`])if(existsSync(join(source,path)))inputs.push([path,digest(read(join(source,path)))])
 for(const prefix of [`.administration/record-heads/${space}`,`.administration/self-heads/${space}`,`spaces/${space}`]){const files=[];walk(source,prefix,files);for(const file of files)if(!file.path.includes('/index/')&&!file.path.includes('/operations/')&&!file.path.includes('/journal/'))inputs.push([file.path,file.sha256])}
 return digest(inputs.sort(([a],[b])=>a.localeCompare(b)))
}
async function prepare(store,source,operationId){
 if(readdirSync(source).some(name=>!['manifest.json','spaces','.administration','exports','backups'].includes(name)&&!/^(?:\.writer(?:-recovery)?\.lock|\.(?:lock-candidate|retired-lock)-[a-f0-9-]{36})$/.test(name)))fail('UNSUPPORTED_SELF_UPGRADE_SOURCE')
 const root=JSON.parse(read(join(source,'manifest.json'))),spaceId=store.memorySpaceId,base=join(source,'spaces',spaceId)
 if(root.format_version!==2||!['1.1.0','1.2.0',API_VERSION].includes(root.api_version)||!root.spaces?.includes(spaceId))fail('UNSUPPORTED_SELF_UPGRADE_SOURCE')
 if(existsSync(join(base,'journal'))&&readdirSync(join(base,'journal')).length)fail('SOURCE_RECOVERY_REQUIRED')
 const manifest=JSON.parse(read(join(base,'manifest.json')))
 if(manifest.format_version!==2||manifest.memory_space_id!==spaceId)fail('UNSUPPORTED_SELF_UPGRADE_SOURCE')
 loadMaintenanceState(source,spaceId)
 const before=observe(source,spaceId),personaState=exportPersonaState(source,spaceId);await validatePortablePersonaState(personaState,spaceId)
 const all=[];for(const prefix of ROOTS)walk(base,prefix,all)
 const files=[],heads=[],legacy=[];let upgrades=0
 const identities={...manifest.identities}
 for(const anchor of personaState.anchors){
  const id=anchor.agent_identity_id,old=loadSelfHead(source,spaceId,id),growth=readSelfFiles(source,spaceId,id)
  if(old){verifySelfFiles(old,growth,anchor);heads.push(old)}else{
   if(root.api_version!=='1.1.0')fail('SELF_UPGRADE_SOURCE_ANCHOR_REQUIRED')
   upgrades++;validateSelfFiles(growth,anchor)
   heads.push(validateSelfHead({schema_version:1,memory_space_id:spaceId,binding_id:anchor.binding_id,persona_id:anchor.persona_id,agent_identity_id:id,subject_id:anchor.subject_id,core_version:anchor.core_version,generation:1,parent_hash:null,operation_id:operationId,files:[],files_hash:digest([])}))
   for(const[path,data]of growth){const moved=`cold/legacy-self/${id}/${path}`;legacy.push(moved);files.push({path:moved,data,size:data.length,sha256:digest(data)})}
  }
  const expected=personaIdentityProjection(anchor)
  if(identities[id]&&digest(identities[id])!==digest(expected))fail('PERSONA_IDENTITY_CONFLICT')
  identities[id]=expected
 }
 if(!upgrades&&root.api_version===API_VERSION)fail('SELF_UPGRADE_NOT_REQUIRED')
 for(const file of all){
  if(isGrowthSelfPath(file.path)){const id=file.path.split('/')[1];if(!personaState.anchors.some(anchor=>anchor.agent_identity_id===id))fail('UNBOUND_SELF_UPGRADE_SOURCE');if(!loadSelfHead(source,spaceId,id))continue}
  if(files.some(old=>old.path===file.path))fail('UPGRADE_DESTINATION_CONFLICT')
  files.push(file)
 }
 const archive=packageOwnerArchive(store,{...manifest,identities},files,{purgeState:exportPurgeState(source,spaceId),personaState,heads:listRecordHeads(source,spaceId),selfState:{schema_version:1,heads}})
 validateTransferArchive(archive)
 if(observe(source,spaceId)!==before)fail('SELF_UPGRADE_SOURCE_CHANGED')
 return{archive,snapshot:before,legacy,identityIds:personaState.anchors.map(anchor=>anchor.agent_identity_id),localSources:sourceProtectionSnapshot(source).state?.sources??[]}
}

/** Explicit separate-root upgrade. Old unanchored traits never become active. */
export async function upgradeLegacySelf(store,args,context){
 const operationId=args?.operation_id??randomUUID()
 let release
 try{
  store._authorize(context,'memory.manage');assertOnly(args,['operation_id','source_root','source_quiescent','expected_snapshot','legacy_self_policy','dry_run'])
  if(typeof args.source_root!=='string'||!isAbsolute(args.source_root))fail('ABSOLUTE_SOURCE_REQUIRED')
  const source=resolve(args.source_root);safe(source)
  if(!existsSync(source)||!lstatSync(source).isDirectory())fail('UNSUPPORTED_SELF_UPGRADE_SOURCE')
  if(inside(source,store.root)||inside(store.root,source))fail('SEPARATE_UPGRADE_ROOT_REQUIRED')
  if(args.source_quiescent!==true)fail('SOURCE_QUIESCENCE_REQUIRED')
  if(args.legacy_self_policy!=='preserve_opaque')fail('EXPLICIT_LEGACY_SELF_POLICY_REQUIRED')
  if(args.dry_run!==undefined&&typeof args.dry_run!=='boolean')fail('INVALID_DRY_RUN')
  release=await acquireRootLock(source);store._authorize(context,'memory.manage')
  const prepared=await prepare(store,source,operationId)
  const lifecycleSchedule=loadMaintenanceState(store.root,store.memorySpaceId)?'preserved_destination':'reinitialized_for_destination'
  store._authorize(context,'memory.manage')
  if(args.dry_run!==false)return{api_version:API_VERSION,status:'preview',source_snapshot:prepared.snapshot,identity_ids:prepared.identityIds,legacy_self_files:prepared.legacy,file_count:prepared.archive.files.length,writes:false,lifecycle_schedule:lifecycleSchedule,source_quiescence:'owner_declared',legacy_policy:'preserved_opaque_not_loaded'}
  if(args.expected_snapshot!==prepared.snapshot)fail('SELF_UPGRADE_SNAPSHOT_CONFLICT')
  const finalCheck=()=>{store._authorize(context,'memory.manage');if(observe(source,store.memorySpaceId)!==prepared.snapshot)fail('SELF_UPGRADE_SOURCE_CHANGED')}
  const administration=new MemoryAdministration({store}),transfer=new MemoryTransfer({store,importGuard:input=>{finalCheck();return administration.assertImportAllowed(input)},finalImportAuthorize:finalCheck,sourceProtectionBuilder:()=>prepareSourceProtection(store.root,source,prepared.snapshot,operationId,prepared.localSources)})
  const imported=await transfer.importSpace({operation_id:operationId,archive:prepared.archive,identity_mode:'preserve',accept_persona_state:true,accept_purge_state:true,accept_integrity_state:true,accept_self_integrity:true},context)
  return{...imported,source_snapshot:prepared.snapshot,lifecycle_schedule:lifecycleSchedule,legacy_self_files:prepared.legacy,legacy_policy:'preserved_opaque_not_loaded'}
 }catch(error){return failure(error,operationId)}finally{release?.()}
}
