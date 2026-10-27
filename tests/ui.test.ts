import {test} from 'node:test';
import assert from 'node:assert/strict';
import {h,signal} from '../packages/ui/src/index.js';
test('JSX element shape',()=>{assert.deepEqual(h('h1',{className:'hi'},'Hello'),{type:'h1',props:{className:'hi',children:['Hello']}});});
test('signal subscriptions and unsubscribe',()=>{const s=signal(0);let updates=0;const unsubscribe=s.subscribe(()=>updates++);s.value=1;s.value=1;assert.equal(updates,1);unsubscribe();s.value=2;assert.equal(updates,1);});
