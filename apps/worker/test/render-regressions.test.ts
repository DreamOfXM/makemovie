import { it, expect } from 'vitest'
import {startTestEnv} from './env.js'
import {composeEpisode} from '../src/compose.js'
import {createComposition} from '@studio/pipeline'
import {readFileSync,writeFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
it('intersects negative audio offsets, silences hidden linked audio, and refuses locked empty selection', async () => {
const env=await startTestEnv(),rows:any[]=[];
try{
 const s=await env.seed({storyboards:2}),[a,b]=s.storyboardIds,va=await env.attachSucceededVideo(s,a,1,{durationMs:5000}),vb=await env.attachSucceededVideo(s,b,1,{durationMs:5000}),tone=await env.attachSucceededMedia(s,{stage:'AUDIO',modality:'tts',storyboardId:a,durationMs:5000});
 await env.db.storyboard.updateMany({where:{episodeId:s.episodeId},data:{dialogue:'',audioSource:'NATIVE'}});
 const clips=[{clipId:'a',storyboardId:a,artifactId:va.artifactId,sourceInFrame:0,sourceOutFrame:125},{clipId:'b',storyboardId:b,artifactId:vb.artifactId,sourceInFrame:0,sourceOutFrame:125}];
 const edit=await env.db.episodeEdit.create({data:{episodeId:s.episodeId,organizationId:s.organizationId,headRevision:1,revisions:{create:{revision:1,fpsNum:25,fpsDen:1,fingerprint:'negative',clips:JSON.stringify(clips),tracks:JSON.stringify([{elementId:'range',sourceArtifactId:tone.artifactId,anchor:'sequence',offsetFrame:-25,gain:1,muted:false,locked:false,sourceInFrame:25,sourceOutFrame:75}])}}}});
 async function compose(name:string){const id=await createComposition({db:env.db,enqueueJob:async()=>{}} as any,s.organizationId,s.episodeId,s.storyboardIds),deps=env.deps(),real=deps.composer;let extras:any[]=[];
 deps.composer={compose:async(input:any,out:any)=>{extras=(input.extras??[]).map((x:any)=>({startMs:x.startMs,durationMs:Math.round(Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',x.file],{encoding:'utf8'}))*1000)}));return real.compose(input,out)},postProcess:(...args:any[])=>real.postProcess(...args as [any,any,any])};await composeEpisode(env.composePayload(id,s),deps);const c=await env.db.composition.findUniqueOrThrow({where:{id}});rows.push({name,status:c.status,manifest:JSON.parse(c.manifest),extras});}
 await compose('negative offset [1s,3s) -1s expected duration 1000ms');
 await env.db.episodeEditRevision.create({data:{editId:edit.id,revision:2,fpsNum:25,fpsDen:1,fingerprint:'hidden',clips:JSON.stringify([{...clips[0],clipId:'__hidden__a'},clips[1]]),tracks:JSON.stringify([{elementId:'linked',sourceArtifactId:tone.artifactId,anchor:'clip',clipId:'__hidden__a',offsetFrame:0,gain:1,muted:false,locked:false}])}});await env.db.episodeEdit.update({where:{id:edit.id},data:{headRevision:2}});
 await compose('hidden A with linked sound, visible B should compose with A muted');
 await env.db.episodeEdit.delete({where:{id:edit.id}});await env.db.storyboard.update({where:{id:a},data:{lockedVideoSelection:true,selectedVideoArtifactId:null}});
 await compose('locked empty selection should not fall back latest');
 expect(rows[0].status).toBe('COMPLETED')
 expect(rows[0].extras[0]).toEqual({startMs:0,durationMs:1000})
 expect(rows[1].status).toBe('COMPLETED')
 expect(rows[1].extras).toHaveLength(0)
 expect(rows[2].status).toBe('BLOCKED')

}finally{await env.stop()}

})
