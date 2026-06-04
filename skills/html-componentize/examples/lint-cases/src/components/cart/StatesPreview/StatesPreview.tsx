// regression fixture for lint-deps: same-feature + shared imports MUST NOT flag
// (also guards the 'view' ⊂ 'Preview' substring false-positive)
import { EmptyState } from './EmptyState';
import { StatePanel } from '@/components/common/StatePanel';
export function StatesPreview() { return <StatePanel><EmptyState /></StatePanel>; }
