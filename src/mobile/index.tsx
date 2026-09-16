import { createRoot } from 'react-dom/client';
import { MobileReadonlyApp } from './App';
import './mobile.css';

export function mountMobileReadonly(element: HTMLElement) {
  const root = createRoot(element);
  root.render(<MobileReadonlyApp />);
  return root;
}

const element = document.getElementById('root');
if (element) mountMobileReadonly(element);
