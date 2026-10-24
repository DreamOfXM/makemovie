import { it, expect } from 'vitest'
import {startTestEnv} from './env.js'
import {runArtifactOperation} from '../src/run-artifact-operation.js'
import {readFileSync,writeFileSync} from 'node:fs'
it('does not adopt a result after operation lease takeover',async()=>{
const env=await startTestEnv();
try{
 const s=await env.seed(),shot=s.storyboardIds[0],a=await env.attachSucceededVideo(s,shot,1,{durationMs:1000});await env.db.storyboard.update({where:{id:shot},data:{selectedVideoArtifactId:a.artifactId,stateRevision:1}});
 const op=await env.db.artifactOperation.create({data:{organizationId:s.organizationId,kind:'video_extend',sourceArtifactId:a.artifactId,connectionId:s.connectionId,capabilityId:s.capabilityId,provider:'mock',model:'mock-t2v',applyPolicy:'apply_if_unchanged',expectedShotRevision:1,requestSnapshot:JSON.stringify({input:{prompt:'extend'},parameters:{durationMs:1000},applyPolicy:'apply_if_unchanged'})}});
 const put=env.storage.put.bind(env.storage);let injected=false;
 env.storage.put=async function(key:any,bytes:any,mime:any){if(String(key).includes(op.id)&&!injected){injected=true;await env.db.artifactOperation.update({where:{id:op.id},data:{claimToken:'new-owner',leaseUntil:new Date(Date.now()+300000),status:'RUNNING'}})}return put(key,bytes,mime)};
 await runArtifactOperation({kind:'run-artifact-operation',operationId:op.id,organizationId:s.organizationId,attempt:1,candidate:s.candidates[0]},env.deps({pollIntervalMs:1}));env.storage.put=put;
 const result={injection:'operation lease ownership transferred in real DB immediately before old owner storage.put/adoption',injected,originalSelection:a.artifactId,shot:await env.db.storyboard.findUnique({where:{id:shot}}),operation:await env.db.artifactOperation.findUnique({where:{id:op.id}})};
 expect(result.injected).toBe(true)
 expect(result.shot?.selectedVideoArtifactId).toBe(result.originalSelection)
 expect(result.operation?.claimToken).toBe('new-owner')

}finally{await env.stop()}

})
