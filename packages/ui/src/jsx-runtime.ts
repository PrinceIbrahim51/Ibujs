import { h, type Props, type VNode } from './index.js';
export const Fragment = (props: Props) => props.children;
export function jsx(type: VNode['type'], props: Props, _key?: string) { return h(type, _key === undefined ? props : {...props, key: _key}); }
export const jsxs = jsx;
