import { createLineApi } from '../common/line-api.ts'
import type { AwsQuickLoginDto, AwsQuickSettingsUpdateDto, AwsQuickStatusDto } from '../../shared/aws-quick-contracts.ts'
const api=createLineApi('/aws-quick/api','AWS Quick')
export const AwsQuickApi={
 status:()=>api.get<AwsQuickStatusDto>('/status'),update:(patch:AwsQuickSettingsUpdateDto)=>api.post<AwsQuickStatusDto>('/settings',patch),refresh:()=>api.post<AwsQuickStatusDto>('/refresh',{}),startLogin:()=>api.post<AwsQuickLoginDto>('/login/start',{}),cancelLogin:()=>api.post<AwsQuickStatusDto>('/login/cancel',{}),prepareTools:()=>api.post<AwsQuickStatusDto>('/tools/prepare',{}),logout:()=>api.post<AwsQuickStatusDto>('/logout',{}),
}
