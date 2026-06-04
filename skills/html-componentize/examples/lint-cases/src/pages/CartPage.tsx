// page→component is layered composition, NOT coupling → must NOT flag
import { CartList } from '@/components/cart/CartList';
export function CartPage() { return <CartList />; }
