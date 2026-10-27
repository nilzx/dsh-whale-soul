import { MEMORY_REVISION_REASON, MemoryError, assertId, assertOnly, digest, timestamp } from './contracts.js'
import { loadRecordHead } from './record-integrity.js'
import { verifyAnchoredOwnerQuotation } from './external-read-authority.js'
import { recordRetentionAllowed } from './read-policy.js'
import { retentionBlockReason } from './retention.js'
import { LIFECYCLE_POLICY_VERSION } from './lifecycle-policy.js'

const permits = new WeakMap(), attempts = new WeakMap(), factualTypes = new Set(['fact','preference','episode'])
const fail = (code) => { throw new MemoryError(code) }
const same = (a,b) => digest(a) === digest(b)
const freeze = (value) => { if(value && typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value)}return value }
const sourceIdentity = ['agent_identity_id','persona_id','subject_id','memory_space_id']

function synchronous(call, code) {
  const result = call()
  if(result && typeof result.then==='function'){Promise.resolve(result).catch(()=>{});fail(code)}
  return result
}
function safe(value) {
  if(typeof value!=='string'||!value.isWellFormed()||retentionBlockReason(value))fail('PROTECTED_CORRECTION_RETENTION_DENIED')
}
function approvedItem(entry) {
  const item=synchronous(()=>entry.resolve(entry.evidenceId),'PROTECTED_CORRECTION_ASYNC_EVIDENCE')
  if(!item || item.type!=='interaction'||item.source!=='user'||item.claim_kind!=='user_statement'||item.allow_persist!==true ||
    !item.event_evidence_id || !item.target_binding || !item.memory_proposal)fail('PROTECTED_CORRECTION_NOT_ADMITTED')
  assertId(item.event_evidence_id);assertId(item.evidence_id);assertId(item.message_id);assertId(item.session_id)
  if(!Array.isArray(item.actor_ids)||!item.actor_ids.length||item.actor_ids.length>32)fail('PROTECTED_CORRECTION_NOT_ADMITTED')
  item.actor_ids.forEach((id)=>assertId(id))
  if(item.evidence_id!==entry.evidenceId || item.operation_id!==`memory-item-${item.evidence_id}` || item.session_id!==entry.context.session_id ||
    sourceIdentity.some((key)=>item[key]!==entry.context[key]))fail('PROTECTED_CORRECTION_SCOPE_MISMATCH')
  if(entry.itemHash && digest(item)!==entry.itemHash)fail('PROTECTED_CORRECTION_EVIDENCE_CHANGED')
  if(digest(item.memory_proposal)!==entry.proposalHash || item.memory_proposal.content!==item.content || item.memory_proposal.gist!==item.content ||
    item.memory_proposal.claim_kind!=='user_statement'||item.memory_proposal.subject_id!==entry.context.subject_id||item.observed_at!==item.occurred_at||
    item.memory_proposal.provenance_refs?.length!==1 || item.memory_proposal.provenance_refs[0]!==item.evidence_id)fail('PROTECTED_CORRECTION_PROPOSAL_CHANGED')
  const target=item.target_binding
  assertId(target.record_id)
  if(!Number.isSafeInteger(target.expected_revision)||target.expected_revision<1 || !factualTypes.has(target.type) ||
    (target.canonical_key??null)!==(item.memory_proposal.canonical_key??null) || target.type!==item.memory_proposal.type ||
    item.memory_proposal.retention!=='long_term')fail('PROTECTED_CORRECTION_TARGET_INVALID')
  safe(item.content);safe(item.memory_proposal.title ?? item.content)
  for(const value of item.memory_proposal.tags??[])safe(value)
  const expected={...item.memory_proposal,operation_id:item.operation_id,record_id:target.record_id,expected_revision:target.expected_revision,reason:MEMORY_REVISION_REASON}
  if(digest(expected)!==entry.argsHash)fail('PROTECTED_CORRECTION_REQUEST_MISMATCH')
  return freeze(structuredClone(item))
}
function ownerOrigin(store,record,head,seen=new Set()) {
  if(seen.size>=16||seen.has(record.meta.revision_id))fail('PROTECTED_CORRECTION_ORIGIN_INVALID')
  seen.add(record.meta.revision_id)
  const external=record.meta.external_revision
  if(external?.protected!==true)fail('PROTECTED_CORRECTION_ORIGIN_INVALID')
  if(record.meta.claim_kind==='quotation'){
    const proof=verifyAnchoredOwnerQuotation(store,record,head)
    if(!proof)fail('PROTECTED_CORRECTION_ORIGIN_INVALID')
    return proof.origin_revision_id
  }
  if(record.meta.claim_kind!=='user_statement'||external.source!=='admitted_user_correction' ||
    record.meta.provenance_refs.length!==1 || record.meta.provenance_refs[0]!==external.correction_evidence_id)fail('PROTECTED_CORRECTION_ORIGIN_INVALID')
  const revision=head.revisions.find((row)=>row.revision_id===record.meta.revision_id)
  if(!revision || revision.parent_revision_id!==external.previous_protected_revision_id || revision.operation_id!==external.correction_operation_id)fail('PROTECTED_CORRECTION_ORIGIN_INVALID')
  const earlier=store._readRecord(record.meta.record_id,external.previous_protected_revision_id)
  const origin=ownerOrigin(store,earlier,head,seen)
  if(origin!==external.owner_revision_id)fail('PROTECTED_CORRECTION_ORIGIN_INVALID')
  return origin
}
function targetRecord(entry,item,provided) {
  const {store,context}=entry,target=item.target_binding
  const head=loadRecordHead(store.root,store.memorySpaceId,target.record_id)
  if(!head || head.state!=='clean')fail('PROTECTED_CORRECTION_TARGET_UNAVAILABLE')
  if(head.schema_version===2&&head.bundle_location!=='records'&&!entry.restoreCold)fail('PROTECTED_CORRECTION_UNSUPPORTED_STATE')
  const record=store._readRecord(target.record_id)
  if(provided&&!same(record,provided))fail('PROTECTED_CORRECTION_TARGET_CHANGED')
  const meta=record.meta
  const cold=meta.lifecycle?.tier==='cold'
  if(cold ? !entry.restoreCold||meta.status!=='archived' : meta.status!=='active'||meta.lifecycle&&meta.lifecycle.tier!=='active'||entry.restoreCold)fail('PROTECTED_CORRECTION_UNSUPPORTED_STATE')
  if(meta.retention!=='long_term'||meta.agreement!==undefined||!factualTypes.has(meta.type)||
    meta.assets!==undefined&&(!Array.isArray(meta.assets)||meta.assets.length))fail('PROTECTED_CORRECTION_UNSUPPORTED_STATE')
  for(const key of ['valid_from','valid_to','expires_at'])timestamp(meta[key],key)
  if(meta.valid_from&&Date.parse(meta.valid_from)>Date.now()||meta.valid_to&&Date.parse(meta.valid_to)<=Date.now()||meta.expires_at&&Date.parse(meta.expires_at)<=Date.now())fail('PROTECTED_CORRECTION_TARGET_UNAVAILABLE')
  if(meta.visibility?.kind!=='private'||sourceIdentity.some((key)=>meta[key]!==context[key])||!store._visible(meta,context))fail('PROTECTED_CORRECTION_SCOPE_MISMATCH')
  if(meta.revision!==target.expected_revision||meta.type!==target.type||(meta.canonical_key??null)!==target.canonical_key)fail('REVISION_CONFLICT')
  if(!recordRetentionAllowed(record))fail('PROTECTED_CORRECTION_RETENTION_DENIED')
  const protectedRecord=meta.external_revision?.protected===true
  if(meta.legacy?.user_edited===true&&!protectedRecord)fail('PROTECTED_CORRECTION_ORIGIN_INVALID')
  if(!protectedRecord&&!cold)fail('PROTECTED_CORRECTION_ORIGIN_INVALID')
  const origin=protectedRecord?ownerOrigin(store,record,head):null
  if(protectedRecord&&meta.claim_kind==='user_statement')for(const ref of meta.provenance_refs){
    const previous=synchronous(()=>entry.resolve(ref),'PROTECTED_CORRECTION_ASYNC_EVIDENCE')
    if(!previous||previous.allow_persist!==true||previous.source!=='user'||previous.claim_kind!=='user_statement'||
      sourceIdentity.some((key)=>previous[key]!==context[key]))fail('PROTECTED_CORRECTION_TARGET_EVIDENCE_REVOKED')
  }
  if(origin){
    const original=store._readRecord(meta.record_id,origin)
    if(!same(meta.title,original.meta.title)||!same(meta.tags,original.meta.tags))fail('PROTECTED_CORRECTION_ORIGIN_INVALID')
  }
  return{record,head,origin,cold,protectedRecord}
}
function validate(entry,{args,context,previous,record}={}) {
  if(context!==entry.context||digest(args)!==entry.argsHash)fail('PROTECTED_CORRECTION_SCOPE_MISMATCH')
  entry.store._authorize(context,'memory.read');entry.store._authorize(context,'memory.write')
  if(entry.signal?.aborted)fail('PROTECTED_CORRECTION_CANCELLED')
  const item=approvedItem(entry)
  if(synchronous(()=>entry.checkBoundary({item,context}),'PROTECTED_CORRECTION_ASYNC_BOUNDARY')!==true)fail('PROTECTED_CORRECTION_FENCE_REQUIRED')
  const target=targetRecord(entry,item,previous)
  if(record){
    // The Store's public proposal contract trims display layers; raw evidence
    // below must still retain the exact approved span, including whitespace.
    if(record.gist!==item.memory_proposal.gist.trim()||record.detail!==item.memory_proposal.content.trim()||record.meta.claim_kind!=='user_statement'||
      record.meta.record_id!==target.record.meta.record_id||record.meta.revision!==target.record.meta.revision+1 ||
      !same(record.meta.provenance_refs,[item.evidence_id])||record.evidence?.length!==1)fail('PROTECTED_CORRECTION_RECORD_MISMATCH')
    const raw=record.evidence[0]
    if(raw.evidence_id!==item.evidence_id||raw.content!==item.content||raw.claim_kind!=='user_statement'||raw.session_id!==item.session_id||raw.message_id!==item.message_id||raw.observed_at!==item.observed_at||
      !same(raw.subject_ids,[context.subject_id])||!same(raw.actor_ids,item.actor_ids))fail('PROTECTED_CORRECTION_RECORD_MISMATCH')
    if(!recordRetentionAllowed(record))fail('PROTECTED_CORRECTION_RETENTION_DENIED')
    if(sourceIdentity.some((key)=>record.meta[key]!==context[key]) || record.meta.type!==target.record.meta.type || record.meta.status!=='active'||record.meta.retention!=='long_term'||
      ['valid_from','valid_to','expires_at'].some((key)=>(record.meta[key]??null)!==(item.memory_proposal[key]??null))||
      (record.meta.canonical_key??null)!==(target.record.meta.canonical_key??null) || !same(record.meta.visibility,target.record.meta.visibility) ||
      target.protectedRecord&&(!same(record.meta.title,target.record.meta.title)||!same(record.meta.tags,target.record.meta.tags))||record.meta.pinned!==target.record.meta.pinned ||
      (record.meta.external_revision?.protected===true)!==target.protectedRecord || target.cold&&record.meta.lifecycle?.tier!=='active')fail('PROTECTED_CORRECTION_RECORD_MISMATCH')
  }
  return{item,...target}
}

/** Host-only admitted correction; restore_cold explicitly includes one bound cold fact. */
export function createProtectedCorrectionAuthority({store,resolveAdmittedItem,checkBoundary}={}) {
  if(typeof store?._authorize!=='function'||typeof store?._readRecord!=='function'||typeof store?.engine?.read!=='function'||
    typeof resolveAdmittedItem!=='function'||typeof checkBoundary!=='function')fail('PROTECTED_CORRECTION_BINDINGS_REQUIRED')
  return Object.freeze({async authorize(input,context,{signal}={}){
    assertOnly(input,['evidence_id','proposal_hash','args','restore_cold'])
    if(input.restore_cold!==undefined&&typeof input.restore_cold!=='boolean')fail('PROTECTED_CORRECTION_UNSUPPORTED_STATE')
    input=structuredClone(input)
    if(signal!==undefined&&!(signal instanceof AbortSignal))fail('INVALID_SIGNAL')
    assertId(input.evidence_id)
    if(!/^[a-f0-9]{64}$/.test(input.proposal_hash??''))fail('PROTECTED_CORRECTION_PROPOSAL_CHANGED')
    const entry={store,resolve:resolveAdmittedItem,checkBoundary,context,signal,evidenceId:input.evidence_id,proposalHash:input.proposal_hash,argsHash:digest(input.args),restoreCold:input.restore_cold===true,status:'issued'}
    await store.engine.read(()=>{const checked=validate(entry,{args:input.args,context});entry.itemHash=digest(checked.item)})
    validate(entry,{args:input.args,context})
    const permit=Object.freeze(Object.create(null));permits.set(permit,entry);return permit
  }})
}

/** Internal Store hook: one reservation belongs to one API invocation only. */
export function reserveProtectedCorrectionPermit(permit,{store,args,context}) {
  const entry=permits.get(permit)
  if(!entry||entry.store!==store)fail('PROTECTED_CORRECTION_PERMIT_INVALID')
  if(entry.status!=='issued')fail('PROTECTED_CORRECTION_PERMIT_USED')
  validate(entry,{args,context})
  const attempt=Object.freeze(Object.create(null));entry.status='reserved';entry.attempt=attempt;attempts.set(attempt,entry);return attempt
}
export function assertProtectedCorrectionAttempt(attempt,options) {
  const entry=attempts.get(attempt)
  if(!entry||entry.status!=='reserved'||entry.attempt!==attempt||entry.store!==options.store)fail('PROTECTED_CORRECTION_PERMIT_USED')
  return validate(entry,options)
}
export function applyProtectedCorrectionMetadata(attempt,options) {
  const {record,...before}=options,checked=assertProtectedCorrectionAttempt(attempt,before),old=checked.record.meta
  if(checked.protectedRecord){
    record.meta.title=old.title;record.meta.tags=structuredClone(old.tags);record.meta.pinned=old.pinned;record.meta.visibility=structuredClone(old.visibility)
    record.meta.external_revision={protected:true,source:'admitted_user_correction',owner_revision_id:checked.origin,
    previous_protected_revision_id:old.revision_id,correction_evidence_id:checked.item.evidence_id,correction_operation_id:options.args.operation_id}
  }
  if(checked.cold)record.meta.lifecycle={schema_version:1,tier:'active',changed_at:record.meta.updated_at,reason_code:'USER_CORRECTION_RESTORED',
    policy_version:LIFECYCLE_POLICY_VERSION,source_revision_id:old.revision_id}
  assertProtectedCorrectionAttempt(attempt,{...options,record})
  return record
}
export function finishProtectedCorrectionAttempt(attempt) {
  const entry=attempts.get(attempt)
  if(entry&&entry.attempt===attempt){entry.status='consumed';delete entry.attempt;attempts.delete(attempt)}
}
