declare global {
  namespace JSX {
    type Element = import('./index.js').VNode;
    interface IntrinsicElements { [element: string]: Record<string, any>; }
  }
}
export {};
