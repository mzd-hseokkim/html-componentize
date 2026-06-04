// regression fixture for lint-deps: page→page via alias MUST be flagged
import { SiteHeader } from '@/components/cart/SiteHeader';
export function MyPage() { return <div><SiteHeader /></div>; }
