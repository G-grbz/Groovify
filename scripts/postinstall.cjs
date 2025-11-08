const { execSync } = require('node:child_process');

const flag =
  process.env.BUILD_ELECTRON === '1' ||
  String(process.env.npm_config_build_electron || '').toLowerCase() === 'true';

if (!flag) {
  console.log('postinstall: electron-builder bağımlılık kurulumu atlandı (BUILD_ELECTRON!=1).');
  process.exit(0);
}

try {
  console.log('postinstall: electron-builder bağımlılık kurulumu başlıyor…');
  execSync('npx electron-builder install-app-deps', { stdio: 'inherit', shell: true });
  console.log('postinstall: electron-builder bağımlılık kurulumu bitti.');
} catch (err) {
  console.error('postinstall: electron-builder kurulumu başarısız:', err?.message || err);
  process.exit(1);
}
