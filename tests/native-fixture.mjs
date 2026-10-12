export const sourceRevision='a'.repeat(64);
export const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
export const metadata={sourceRevision,screenState:'Настройки · ru · тестовая сцена'};
export function buddyFrame(text='Нативный текст') {
  return {type:'frame',preview:'test.SettingsPreview',image:png,densityDpi:160,semantics:{id:0,name:'Root',bounds:{left:0,top:0,right:1,bottom:1},children:[{id:7,name:'Text',bounds:{left:.2,top:.2,right:.8,bottom:.5},sourceFile:'Settings.kt',sourceLine:42,mergedSemantics:{text,fontSize:'14.0.sp',fontWeight:'Normal (400)',fontFamily:'FontFamily.SansSerif',letterSpacing:'0.5.sp'},children:[]}]}};
}
