import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryError, assertOnly, digest } from './contracts.js'
import { getPersonaAnchor } from './persona-ledger.js'
import { buildSelfDescriptor, loadSelfHead, pruneSelfFiles, readSelfFiles, selfAnchor, validateSelfHead, validateSelfFiles, verifySelfFiles } from './self-integrity.js'

const fail=(code)=>{throw new MemoryError(code)}
const copy=(value)=>JSON.parse(JSON.stringify(value))
const scope=['memory_space_id','binding_id','persona_id','agent_identity_id','subject_id','core_version']
export const isGrowthSelfPath=(path)=>/^self\/[^/]+\/(?:manifest\.json|(?:traits|proposals)\/[^/]+\.json|history\/[^/]+\/[1-9][0-9]*\.json)$/.test(path)
const filesFor=(files,id)=>new Map(files.filter(file=>isGrowthSelfPath(file.path)&&file.path.startsWith(`self/${id}/`)).map(file=>[file.path.slice(`self/${id}/`.length),file.data]))
export function validatePortableSelfState(state,files,anchors,spaceId){
 assertOnly(state,['schema_version','heads'])
 if(state.schema_version!==1||!Array.isArray(state.heads)||state.heads.length>1000)fail('INVALID_TRANSFER_SELF_STATE')
 const seen=new Set()
 for(const head of state.heads){validateSelfHead(head);const anchor=anchors.find(item=>item.agent_identity_id===head.agent_identity_id);if(!anchor||head.memory_space_id!==spaceId||seen.has(head.agent_identity_id)||scope.some(key=>head[key]!==anchor[key]))fail('TRANSFER_SELF_SCOPE_CONFLICT');seen.add(head.agent_identity_id);verifySelfFiles(head,filesFor(files,head.agent_identity_id),anchor)}
 if(anchors.some(anchor=>!seen.has(anchor.agent_identity_id))||files.some(file=>isGrowthSelfPath(file.path)&&!seen.has(file.path.split('/')[1])))fail('TRANSFER_SELF_HEAD_REQUIRED')
 return state
}
export function exportSelfState(root,spaceId,files,anchors){
 const heads=anchors.map(anchor=>{const head=loadSelfHead(root,spaceId,anchor.agent_identity_id);if(!head)fail('SELF_INTEGRITY_UPGRADE_REQUIRED');verifySelfFiles(head,readSelfFiles(root,spaceId,anchor.agent_identity_id),anchor);return copy(head)})
 const state={schema_version:1,heads};validatePortableSelfState(state,files,anchors,spaceId);return state
}
export function validateImportedSelfDescriptor(descriptor){assertOnly(descriptor,['expected_generation','next']);if(descriptor.expected_generation!==0)fail('INVALID_SELF_IMPORT');validateSelfHead(descriptor.next);return descriptor}
export function commitImportedSelfHead(root,spaceRoot,descriptor,write){
 validateImportedSelfDescriptor(descriptor);if(typeof write!=='function')fail('TRUSTED_SYNC_WRITER_REQUIRED');const next=descriptor.next,old=loadSelfHead(root,next.memory_space_id,next.agent_identity_id)
 if(old){if(digest(old)!==digest(next))fail('SELF_IMPORT_CONFLICT');return}
 const anchor=selfAnchor(root,next.memory_space_id,next.agent_identity_id);if(scope.some(key=>next[key]!==anchor[key]))fail('SELF_SCOPE_CONFLICT')
 if(join(root,'spaces',next.memory_space_id)!==spaceRoot)fail('SELF_SPACE_MISMATCH')
 const result=write(join(root,'.administration/self-heads',next.memory_space_id,`${next.agent_identity_id}.json`),JSON.stringify(next,null,2)+'\n');if(result&&typeof result.then==='function'){Promise.resolve(result).catch(()=>{});fail('TRUSTED_SYNC_WRITER_REQUIRED')}
}
/** Keep local authority unless exact source bytes or committed pruning agree. */
export function prepareSelfImport(root,spaceId,state,files,anchors,operationId,removedIds=[]){
 validatePortableSelfState(state,files,anchors.map(anchor=>({...anchor,core_version:state.heads.find(head=>head.agent_identity_id===anchor.agent_identity_id)?.core_version??anchor.core_version})),spaceId)
 const imports=[],changes=[],coveredIds=[]
 for(const incoming of state.heads){
  const id=incoming.agent_identity_id,anchor=anchors.find(item=>item.agent_identity_id===id),old=loadSelfHead(root,spaceId,id),desired=filesFor(files,id)
  if(incoming.core_version!==anchor.core_version)fail('SELF_CORE_COMPATIBILITY_REQUIRED')
  coveredIds.push(id)
  if(!old){
   const previous=getPersonaAnchor(root,spaceId,incoming.binding_id)
   if(previous||readSelfFiles(root,spaceId,id).size)fail('SELF_INTEGRITY_UPGRADE_REQUIRED')
   imports.push({expected_generation:0,next:copy(incoming)})
   for(const[path,data]of desired)changes.push({path:`self/${id}/${path}`,data})
   continue
  }
  const previousAnchor=selfAnchor(root,spaceId,id),current=readSelfFiles(root,spaceId,id);verifySelfFiles(old,current,previousAnchor)
  const projected=pruneSelfFiles(current,[...removedIds,...anchor.revoked_ids])
  const expected=buildSelfDescriptor({root,spaceId,anchor,files:projected,operationId,previous:old})
  if(expected.next.files_hash!==incoming.files_hash)fail('SELF_IMPORT_CONFLICT')
  for(const path of new Set([...current.keys(),...desired.keys()])){
   const data=desired.get(path);if(data&&current.has(path)&&digest(current.get(path))===digest(data))continue
   changes.push({path:`self/${id}/${path}`,data:data??null})
  }
 }
 return{imports,changes,coveredIds}
}

/** Regenerate only hash metadata after authorized removal of original refs. */
export function prunePortableSelfArchive(archive,removedIds){
 const decoded=archive.files.map(file=>({path:file.path,data:Buffer.from(file.data,'base64')})),anchors=archive.persona_state?.anchors??[]
 validatePortableSelfState(archive.self_integrity_state,decoded,anchors,archive.memory_space_id)
 const heads=[],files=[]
 for(const head of archive.self_integrity_state.heads){
  const anchor=anchors.find(item=>item.agent_identity_id===head.agent_identity_id),original=filesFor(decoded,head.agent_identity_id),next=pruneSelfFiles(original,removedIds)
  const entries=validateSelfFiles(next,anchor),filesHash=digest(entries)
  heads.push(filesHash===head.files_hash?copy(head):validateSelfHead({...head,generation:head.generation+1,parent_hash:digest(head),operation_id:`portable-purge-${digest(removedIds).slice(0,40)}`,files:entries,files_hash:filesHash}))
  for(const[path,data]of next)files.push({path:`self/${head.agent_identity_id}/${path}`,encoding:'base64',size:data.length,sha256:digest(data),data:Buffer.from(data).toString('base64')})
 }
 return{state:{schema_version:1,heads},files}
}
