import React from 'react';
interface Props {
    onModelChange?: () => void;
    loadModelDirectory?: () => void;
}
/** Parse "1M", "512K", "200000" into a positive integer token count. */
export declare function parsePositiveCapacity(value: string): number | null;
export declare function formatCapacity(value: number): string;
export declare function KimiCodeSection({ onModelChange, loadModelDirectory }: Props): React.ReactElement;
export {};
//# sourceMappingURL=KimiCodeSection.d.ts.map