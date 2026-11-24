import type { CommandCodeModelOption } from '../../../shared/command-code-contracts.ts'
import type { ModelChecklistGroup } from '../../common/ModelChecklist.tsx'
import { modelVendorGroup } from '../../common/model-vendors.ts'

/** Display vendor of a Command Code model; see `common/model-vendors.ts`. */
export function commandCodeModelVendor(
  model: Pick<CommandCodeModelOption, 'id'>,
  otherLabel: string,
): ModelChecklistGroup {
  return modelVendorGroup(model.id, otherLabel)
}
