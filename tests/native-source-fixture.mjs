import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {sourceRevision} from '../scripts/native-project.mjs';
export async function nativeSourceFixture(root) {
  await mkdir(path.join(root,'app/src/main/res/values'),{recursive:true});
  const code='package test\n@Composable fun Settings() {\n  Text("Нативный текст", fontSize = 14.sp)\n  Text("Нативный текст")\n  Text(stringResource(R.string.native_label))\n  // Text("Нативный текст")\n  /* nested /* "Нативный текст" */ comment */\n  Text("Нативный текст${suffix}")\n}\n';
  await writeFile(path.join(root,'app/src/main/Settings.kt'),code);
  await writeFile(path.join(root,'app/src/main/res/values/strings.xml'),'<resources><!-- <string name="fake">Нативный текст</string> --><string name="native_label">Нативный текст</string></resources>');
  await writeFile(path.join(root,'.bridge-native-workspace.json'),JSON.stringify({format:'compose-visual-bridge-workspace-v1',module:':app'}));
  const apk='app/build/outputs/apk/debug/app-debug.apk';await mkdir(path.dirname(path.join(root,apk)),{recursive:true});await writeFile(path.join(root,apk),'test-apk');
  const revision=await sourceRevision(root),apkSha256=createHash('sha256').update('test-apk').digest('hex');
  await writeFile(path.join(root,'bridge-native-build.json'),JSON.stringify({format:'compose-visual-bridge-catalog-v1',sourceRevision:revision,apk,apkSha256,previews:['test.SettingsPreview']}));
  return {revision,code,file:path.join(root,'app/src/main/Settings.kt')};
}
