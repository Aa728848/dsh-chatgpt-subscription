/**
 * Capability table for the Kimi model list.
 *
 * Extracted from the settings card so the layout is testable: an earlier
 * revision inlined each capability as prose beside the model name, which
 * stretched the name column and pushed the descriptions out of alignment.
 * Capabilities are now short tags in their own columns, with the per-model
 * detail kept in a hover title.
 */
import React from 'react';
import type { KimiCodeModelOption } from '../../shared/kimi-code-contracts.ts';
export interface KimiModelCapabilitiesProps {
    models: KimiCodeModelOption[];
}
export declare function KimiModelCapabilities({ models }: KimiModelCapabilitiesProps): React.ReactElement;
//# sourceMappingURL=KimiModelCapabilities.d.ts.map