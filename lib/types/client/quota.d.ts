import type { QuotaBucketDto, QuotaStatusDto, QuotaWindowDto } from '../shared/contracts.ts';
export interface SelectedQuotaWindow {
    bucket: QuotaBucketDto;
    window: QuotaWindowDto;
    remainingPercent: number;
}
export declare function selectQuotaForModel(quota: QuotaStatusDto | undefined, modelId: string | undefined): SelectedQuotaWindow | null;
export declare function quotaWindows(bucket: QuotaBucketDto): QuotaWindowDto[];
//# sourceMappingURL=quota.d.ts.map