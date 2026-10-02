import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'kz.kbm.safecheck',
  appName: '360 SafeCheck Driver',
  webDir: 'out',
  server: {
    url: 'https://safecheck-360.vercel.app',
    cleartext: false
  },
  android: { allowMixedContent: false }
};
export default config;
