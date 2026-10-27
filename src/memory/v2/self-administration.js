import { upgradeLegacySelf } from './self-upgrade.js'
import { randomUUID } from 'node:crypto'
import { API_VERSION, MemoryError, assertId, assertOnly, digest, failure } from './contracts.js'
import { loadSelfHead, readSelfFiles, selfAnchor, validateSelfHead, verifySelfFiles, verifySelfIntegrity } from './self-integrity.js'

const fail = (code) => { throw new MemoryError(code) }
/** Local owner recovery restores only bytes already named by the trusted head. */
export class PersonaSelfAdministration {
  constructor({store} = {}) { if (!store?.managedTransaction) fail('MANAGED_MEMORY_REQUIRED'); this.store=store }
  #authorize(ctx) { return this.store._authorize(ctx,'memory.manage') }
  upgradeLegacySelf(args,ctx) { return upgradeLegacySelf(this.store,args,ctx) }
  async status(args,ctx) {
    try {
      this.#authorize(ctx); assertOnly(args,['agent_identity_id']); const id=assertId(args.agent_identity_id)
      return await this.store.managedRead(ctx,()=>{this.#authorize(ctx); const head=loadSelfHead(this.store.root,this.store.memorySpaceId,id); if(!head) return {api_version:API_VERSION,status:'upgrade_required',reason_code:'SELF_INTEGRITY_UPGRADE_REQUIRED',agent_identity_id:id}; let valid=true; try{verifySelfIntegrity(this.store.root,this.store.memorySpaceId,id)}catch{valid=false} return {api_version:API_VERSION,status:valid?'clean':'repair_required',reason_code:valid?'OK':'EXTERNAL_SELF_CHANGE',agent_identity_id:id,generation:head.generation,files_hash:head.files_hash,file_count:head.files.length}})
    }catch(error){return failure(error)}
  }
  async exportSelf(args,ctx) {
    try{
      this.#authorize(ctx);assertOnly(args,['agent_identity_id']);const id=assertId(args.agent_identity_id)
      return await this.store.managedRead(ctx,()=>{this.#authorize(ctx);const {head,files}=verifySelfIntegrity(this.store.root,this.store.memorySpaceId,id);const snapshot={snapshot_format:'dsh-persona-self',snapshot_version:1,head,files:[...files].map(([path,data])=>({path,data:Buffer.from(data).toString('base64')}))};snapshot.checksum=digest(snapshot);return {api_version:API_VERSION,status:'ok',snapshot}})
    }catch(error){return failure(error)}
  }
  async restoreSelf(args,ctx) {
    const operationId=args?.operation_id??randomUUID()
    try{
      this.#authorize(ctx);assertOnly(args,['operation_id','agent_identity_id','expected_generation','source_snapshot']);const id=assertId(args.agent_identity_id)
      if(!Number.isSafeInteger(args.expected_generation)||args.expected_generation<1)fail('EXPECTED_GENERATION_REQUIRED')
      const source=args.source_snapshot;assertOnly(source,['snapshot_format','snapshot_version','head','files','checksum'])
      if(source.snapshot_format!=='dsh-persona-self'||source.snapshot_version!==1||!Array.isArray(source.files)||source.files.length>4096)fail('INVALID_SELF_RESTORE_SOURCE')
      const {checksum,...unsigned}=source;if(checksum!==digest(unsigned))fail('SELF_RESTORE_SOURCE_HASH_MISMATCH')
      validateSelfHead(source.head);if(source.head.memory_space_id!==this.store.memorySpaceId||source.head.agent_identity_id!==id)fail('SELF_SCOPE_CONFLICT')
      const files=new Map();let total=0
      for(const file of source.files){assertOnly(file,['path','data']);if(typeof file.data!=='string'||Buffer.from(file.data,'base64').toString('base64')!==file.data||files.has(file.path))fail('INVALID_SELF_RESTORE_SOURCE');const bytes=Buffer.from(file.data,'base64');total+=bytes.length;if(total>16*1024*1024)fail('SELF_BUNDLE_TOO_LARGE');files.set(file.path,bytes)}
      return await this.store.managedTransaction(operationId,{action:'restoreSelf',agent_identity_id:id,expected_generation:args.expected_generation,source_checksum:checksum},()=>{
        this.#authorize(ctx)
        const anchor=selfAnchor(this.store.root,this.store.memorySpaceId,id),head=loadSelfHead(this.store.root,this.store.memorySpaceId,id)
        if(!head||head.generation!==args.expected_generation||head.files_hash!==source.head.files_hash||head.core_version!==source.head.core_version||['binding_id','persona_id','subject_id'].some((key)=>head[key]!==source.head[key]))fail('SELF_RESTORE_CONFLICT')
        verifySelfFiles(head,files,anchor)
        const current=readSelfFiles(this.store.root,this.store.memorySpaceId,id),changes=[]
        for(const path of new Set([...current.keys(),...files.keys()]))changes.push({path:`self/${id}/${path}`,data:files.get(path)??null})
        return {changes,self_restoration:{agent_identity_id:id,expected_generation:head.generation,files_hash:head.files_hash},result:{api_version:API_VERSION,operation_id:operationId,status:'restored',reason_code:'TRUSTED_SELF_RESTORED',agent_identity_id:id,generation:head.generation+1,pending:false}}
      },ctx,{authorize:()=>this.#authorize(ctx)})
    }catch(error){return failure(error,operationId)}
  }
}
