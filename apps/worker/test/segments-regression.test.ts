import { it, expect } from 'vitest'
import {startTestEnv} from './env.js'
import {runTask} from '../src/run-task.js'
import {MockProviderAdapter} from '@studio/providers'
import {readFileSync,writeFileSync} from 'node:fs'
it('resumes accepted storyboard segments without resubmitting completed ones',async()=>{
const env=await startTestEnv(),orig=MockProviderAdapter.prototype.submit,poll=MockProviderAdapter.prototype.poll;let calls=0,polls=0,hold=true;
try{
 const s=await env.seed({model:'mock-storyboard',modality:'text',stage:'STORYBOARD',storyboards:0});
 const scene='雨水顺着屋檐落下，沈亦在灯下翻看照片。'.repeat(36),content=Array.from({length:10},(_,i)=>`场景 ${i+1}：老城区\n${scene}`).join('\n\n'),script=await env.db.scriptVersion.create({data:{episodeId:s.episodeId,version:1,content,checksum:'segment-audit',status:'APPROVED'}});
 await env.db.episode.update({where:{id:s.episodeId},data:{targetDurationMs:480000}});await env.db.generationTask.update({where:{id:s.taskId},data:{requestSnapshot:JSON.stringify({model:'mock-storyboard',input:{prompt:'break the script into shots'},parameters:{},scriptVersionId:script.id})}});
 MockProviderAdapter.prototype.submit=async function(...args:any[]){calls++;return orig.apply(this,args as any)};MockProviderAdapter.prototype.poll=async function(cap:any,id:string){polls++;return hold?{status:'running'}:poll.call(this,cap,id)};
 await runTask(env.runPayload(s),env.deps({qcMode:'pass',pollIntervalMs:1,pollTimeoutMs:20}));const before={calls,polls,task:await env.db.generationTask.findUnique({where:{id:s.taskId}}),attempts:await env.db.submissionAttempt.findMany({where:{taskId:s.taskId}})};
 hold=false;await runTask(env.runPayload(s),env.deps({qcMode:'pass',pollIntervalMs:1,pollTimeoutMs:5000}));const after={calls,polls,task:await env.db.generationTask.findUnique({where:{id:s.taskId}}),attempts:await env.db.submissionAttempt.findMany({where:{taskId:s.taskId}})};
 expect(before.task?.status).toBe('BLOCKED')
 expect(after.task?.status).toBe('SUCCEEDED')
 expect(after.polls).toBeGreaterThan(before.polls)
 expect(after.calls).toBe(5)
 expect(await env.db.mediaArtifact.count({where:{taskId:s.taskId}})).toBe(5)

}finally{MockProviderAdapter.prototype.submit=orig;MockProviderAdapter.prototype.poll=poll;await env.stop()}

})
