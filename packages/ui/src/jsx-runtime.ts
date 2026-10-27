import { h, Fragment, type Child, type Props, type VNode } from './vnode.js';
import type { Signal } from './signals.js';
import type { ClassValue } from './security.js';
export { Fragment };

export function jsx(type: VNode['type'], props: Props, key?: string | number) {
  return h(type, key === undefined ? props : { ...props, key });
}
export const jsxs = jsx;
export const jsxDEV = jsx;

type Handler<E extends Event, T = HTMLElement> = (event: E & { currentTarget: T }) => void;
type InputHandler = (event: Event & { target: HTMLInputElement; currentTarget: HTMLInputElement }) => void;

export interface HTMLProps {
  children?: Child;
  key?: string | number;
  ref?: ((el: any) => void) | { current: any };
  bind?: Signal<any>;
  class?: ClassValue;
  className?: ClassValue;
  style?: string | Record<string, string | number | null | undefined | false>;
  id?: string;
  title?: string;
  role?: string;
  href?: string;
  src?: string;
  alt?: string;
  type?: string;
  name?: string;
  value?: string | number | readonly string[];
  placeholder?: string;
  checked?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  htmlFor?: string;
  onClick?: Handler<MouseEvent>;
  onInput?: InputHandler;
  onChange?: InputHandler;
  onSubmit?: Handler<SubmitEvent, HTMLFormElement>;
  onKeyDown?: Handler<KeyboardEvent>;
  onKeyUp?: Handler<KeyboardEvent>;
  onFocus?: Handler<FocusEvent>;
  onBlur?: Handler<FocusEvent>;
  // Any other attribute (aria-*, data-*, SVG attributes, other events) is allowed.
  [attribute: string]: any;
}

export namespace JSX {
  export type Element = VNode;
  export type ElementType = string | ((props: any) => Child);
  export interface ElementChildrenAttribute { children: {} }
  export interface IntrinsicAttributes { key?: string | number }
  export interface IntrinsicElements { [tag: string]: HTMLProps }
}
