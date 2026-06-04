// a .test. file → excluded from coupling scan → must NOT flag
import { HomePage } from '@/pages/HomePage';
it('renders', () => { HomePage; });
