import { it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {startTestEnv} from './env.js'
import {readFileSync,writeFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
it('keeps visual findings during technical recheck and persists lazy-check warnings including legacy snapshots', async () => {
const p=mkdtempSync(tmpdir()+'/quality-isolation-'),env=await startTestEnv(),rows:any[]=[];
execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=red:size=160x120:rate=25:duration=5','-f','lavfi','-i','sine=frequency=1000:duration=5','-c:v','libx264','-c:a','aac',p+'/native5.mp4']);
try{
 const u=await env.register('review6-quality@example.com','quality6'),headers=env.authHeaders(u.token);let number=0;
 async function seed(bytes:Buffer){number++;const project=await env.db.project.create({data:{organizationId:u.organization.id,name:'quality'+number}}),ep=await env.db.episode.create({data:{projectId:project.id,number:1,title:'quality'}}),shot=await env.db.storyboard.create({data:{episodeId:ep.id,number:1,title:'shot',description:'x',durationMs:5000,sourceExcerpt:'',continuityIn:'',continuityOut:''}}),batch=await env.db.generationBatch.create({data:{organizationId:u.organization.id,episodeId:ep.id,stage:'VIDEO',status:'COMPLETED',plannedCount:1}}),task=await env.db.generationTask.create({data:{organizationId:u.organization.id,batchId:batch.id,storyboardId:shot.id,stage:'VIDEO',status:'SUCCEEDED',provider:'mock',model:'mock-t2v',idempotencyKey:shot.id}});
 const stored=await env.app.storage.put(`quality${number}.mp4`,bytes,'video/mp4');const video=await env.db.mediaArtifact.create({data:{organizationId:u.organization.id,taskId:task.id,stage:'VIDEO',objectKey:stored.key,checksum:stored.checksum,mimeType:'video/mp4',durationMs:5000,version:1}});await env.db.storyboard.update({where:{id:shot.id},data:{selectedVideoArtifactId:video.id}});
 const storedMaster=await env.app.storage.put(`quality-master${number}.mp4`,bytes,'video/mp4'),master=await env.db.mediaArtifact.create({data:{organizationId:u.organization.id,stage:'COMPOSITION',objectKey:storedMaster.key,checksum:storedMaster.checksum,mimeType:'video/mp4',durationMs:5000,version:1}}),c=await env.db.composition.create({data:{episodeId:ep.id,status:'COMPLETED',artifactId:master.id,inputFingerprint:'stable',manifest:JSON.stringify({storyboardIds:[shot.id]})}});return{ep,c,master}}
 const a=await seed(readFileSync(p+'/native5.mp4'));
 const finding=await env.db.qualityFinding.create({data:{organizationId:u.organization.id,episodeId:a.ep.id,compositionId:a.c.id,fingerprint:'stable',findingKey:'visual:continuity:1',dimension:'continuity',severity:'warning',message:'seeded existing visual finding: prop changes across shot',status:'open'}});
 async function deliver(ep:string){const r=await env.app.inject({method:'POST',url:`/api/episodes/${ep}/deliveries`,headers});return {status:r.statusCode,body:r.json()}}
 const before=await deliver(a.ep.id),review=await env.app.inject({method:'POST',url:`/api/episodes/${a.ep.id}/reviews`,headers}),afterRow=await env.db.qualityFinding.findUniqueOrThrow({where:{id:finding.id}}),after=await deliver(a.ep.id);
 rows.push({name:'technical recheck closes another checker finding',fixture:'real existing open continuity finding seeded in isolated DB; technical review uses actual media',before,review:{status:review.statusCode,body:review.json()},afterRow,after});
 const black=p+'/black5.mp4';execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=black:size=160x120:rate=25:duration=5','-f','lavfi','-i','sine=frequency=1000:duration=5','-c:v','libx264','-c:a','aac',black]);const b=await seed(readFileSync(black)),blackDelivery=await deliver(b.ep.id),blackComposition=await env.db.composition.findUniqueOrThrow({where:{id:b.c.id}}),count=await env.db.qualityFinding.count({where:{compositionId:b.c.id}});
 rows.push({name:'first delivery technical warning bypasses finding queue',delivery:blackDelivery,compositionManifest:JSON.parse(blackComposition.manifest),findingRows:count});
 expect(before.status).toBe(409)
 expect(afterRow.status).toBe('open')
 expect(after.status).toBe(409)
 expect(blackDelivery.status).toBe(409)
 expect(count).toBeGreaterThan(0)
 await env.db.qualityFinding.deleteMany({ where: { compositionId: b.c.id } })
 expect((await deliver(b.ep.id)).status).toBe(409)
 expect(await env.db.qualityFinding.count({ where: { compositionId: b.c.id } })).toBeGreaterThan(0)

}finally{await env.stop();rmSync(p,{recursive:true,force:true})}
})
