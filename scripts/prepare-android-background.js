import fs from "node:fs";
import path from "node:path";

const javaRoot = path.resolve("android/app/src/main/java");
const manifestPath = path.resolve("android/app/src/main/AndroidManifest.xml");

function findFile(directory, name) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.name === name) return full;
  }
  return null;
}

const activityPath = findFile(javaRoot, "MainActivity.java");
if (!activityPath) throw new Error("Generated MainActivity.java was not found.");
const packageDir = path.dirname(activityPath);
for (const name of ["BackgroundScanPlugin.java", "HarsiScanService.java"]) {
  fs.copyFileSync(path.resolve("android-native", name), path.join(packageDir, name));
}

let activity = fs.readFileSync(activityPath, "utf8");
if (!activity.includes("BackgroundScanPlugin.class")) {
  if (!activity.includes("import android.os.Bundle;")) {
    activity = activity.replace(
      /import com\.getcapacitor\.BridgeActivity;\s*/,
      "import com.getcapacitor.BridgeActivity;\nimport android.os.Bundle;\n"
    );
  }
  activity = activity.replace(
    /public class MainActivity extends BridgeActivity\s*\{\s*\}/,
    "public class MainActivity extends BridgeActivity {\n" +
    "    @Override\n    public void onCreate(Bundle savedInstanceState) {\n" +
    "        registerPlugin(BackgroundScanPlugin.class);\n" +
    "        super.onCreate(savedInstanceState);\n    }\n}"
  );
  if (!activity.includes("BackgroundScanPlugin.class")) {
    throw new Error("Could not patch the generated MainActivity.java safely.");
  }
  fs.writeFileSync(activityPath, activity);
}

let manifest = fs.readFileSync(manifestPath, "utf8");
const permissions = [
  '<uses-permission android:name="android.permission.WAKE_LOCK" />',
  '<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />',
  '<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />',
  '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />'
];
for (const permission of permissions) {
  if (!manifest.includes(permission)) manifest = manifest.replace("<application", permission + "\n    <application");
}
if (!manifest.includes("HarsiScanService")) {
  manifest = manifest.replace(
    "</application>",
    '        <service android:name=".HarsiScanService" android:exported="false" android:foregroundServiceType="dataSync" />\n    </application>'
  );
}
fs.writeFileSync(manifestPath, manifest);
console.log("Installed Harsi native scan service and permissions.");
