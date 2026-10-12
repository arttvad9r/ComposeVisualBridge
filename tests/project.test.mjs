import test from 'node:test';import assert from 'node:assert/strict';
import {blankScreen,validatePalette,instantiateComponent} from '../project.mjs';
import {validate,indexTree} from '../public/model.mjs';
import {transferNeeds} from '../public/compose-capabilities.mjs';
import {generateCompose} from '../compose.mjs';
test('Новый экран хранит запрос отдельно от поведения; палитра сохраняет исходники и создаёт независимые экземпляры',()=>{
 const blank=blankScreen({name:' Новый экран ',request:'Добавь список и переход в детали'});assert.equal(blank.name,'Новый экран');assert.equal(blank.state.creationRequest,'Добавь список и переход в детали');assert.equal(blank.root.children.length,0);validate(blank);assert.throws(()=>blankScreen({name:''}),/название/);
 const palette=validatePalette({format:'compose-visual-bridge-palette-v1',sourceRevision:'revision',components:[{id:'card',name:'Карточка проекта',node:{id:'card',type:'Card',props:{background:'#123456'},source:{file:'Card.kt',symbol:'ProjectCard'},children:[{id:'title',type:'Text',props:{text:'Название'}}]}}]});
 const a=instantiateComponent(palette.components[0]),b=instantiateComponent(palette.components[0]);assert.equal(a.source.symbol,'ProjectCard');for(const id of indexTree(a).keys())assert.ok(!indexTree(b).has(id));assert.equal(palette.components[0].node.id,'card');assert.throws(()=>validatePalette({...palette,components:[{...palette.components[0],node:{id:'x',type:'Text',props:{text:'x'}}}]}),/связь/);
 assert.equal(transferNeeds(blank,blank)[0].property,'screen');assert.match(generateCompose(blank,{packageName:'test',symbol:'NewScreen'}),/@Composable fun NewScreen/);
 const baseline=structuredClone(blank);baseline.state={};const current=structuredClone(baseline);current.root.children.push(a);current.state.paletteInsertions=[{id:a.id,component:'card',sourceRevision:'revision'}];validate(current);assert.ok(transferNeeds(baseline,current).some(item=>item.property==='projectComponent'));assert.throws(()=>generateCompose(current,{packageName:'test',symbol:'NewScreen'}),/компонент палитры/);assert.throws(()=>validate({...blank,state:{paletteInsertions:{}}}),/связи палитры/);
});
