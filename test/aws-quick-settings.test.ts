import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {afterEach,describe,expect,it} from 'vitest'
import {AwsQuickSettingsStore,defaultAwsQuickSettings,parseAwsQuickSettings} from '../src/host/aws-quick/settings.ts'
const cleanup:string[]=[]
afterEach(async()=>{for(const file of cleanup.splice(0)){await fs.unlink(file).catch(()=>undefined);await fs.rmdir(path.dirname(file)).catch(()=>undefined)}})
describe('AWS Quick settings',()=>{
 it('keeps unset and explicit empty model selections distinct',()=>{
  expect(parseAwsQuickSettings({enabledModelIds:null}).enabledModelIds).toBeNull()
  expect(parseAwsQuickSettings({enabledModelIds:[]}).enabledModelIds).toEqual([])
  expect(parseAwsQuickSettings({enabled:'bad'}).enabled).toBe(false)
  expect(defaultAwsQuickSettings().accountProvider).toBe('social')
 })
 it('round-trips the production writer and reader without credentials',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-aws-quick-'));const file=path.join(dir,'settings.json');cleanup.push(file)
  const store=new AwsQuickSettingsStore(file)
  await store.update({accountProvider:'enterprise',region:'us-east-1',defaultMode:'smart',defaultReasoningEffort:'high',enabledModelIds:[]})
  const restored=await new AwsQuickSettingsStore(file).read()
  expect(restored).toMatchObject({accountProvider:'enterprise',region:'us-east-1',defaultMode:'smart',defaultReasoningEffort:'high',enabledModelIds:[]})
  const raw=await fs.readFile(file,'utf8');expect(raw).not.toMatch(/jwt|id_token|refresh_token|access_token/i)
 })
})
