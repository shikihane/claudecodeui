const { promises: fs } = require('fs');
const path = require('path');
const os = require('os');
const matter = require('gray-matter');

async function test() {
  const homeDir = os.homedir();

  // Test user skills
  const skillsDir = path.join(homeDir, '.claude', 'skills');
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  let userCount = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const p = path.join(skillsDir, entry.name, 'SKILL.md');
    try {
      const content = await fs.readFile(p, 'utf8');
      const { data } = matter(content);
      console.log('USER:', '/' + (data.name || entry.name), '|', (data.description || '').slice(0, 60));
      userCount++;
    } catch (e) {}
  }
  console.log('User skills total:', userCount);
  console.log('---');

  // Test plugin skills
  const installedJson = path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json');
  const raw = JSON.parse(await fs.readFile(installedJson, 'utf8'));
  const plugins = raw.plugins || {};
  let pluginCount = 0;
  for (const [key, installs] of Object.entries(plugins)) {
    const name = key.split('@')[0];
    const installPath = installs && installs[0] && installs[0].installPath;
    if (!installPath) continue;
    const sd = path.join(installPath, 'skills');
    try {
      const se = await fs.readdir(sd, { withFileTypes: true });
      for (const e of se) {
        if (!e.isDirectory()) continue;
        try {
          const c = await fs.readFile(path.join(sd, e.name, 'SKILL.md'), 'utf8');
          const { data } = matter(c);
          console.log('PLUGIN:', '/' + name + ':' + (data.name || e.name));
          pluginCount++;
        } catch (e2) {}
      }
    } catch (e3) {}
  }
  console.log('Plugin skills total:', pluginCount);
  console.log('---');
  console.log('Grand total:', userCount + pluginCount);
}
test().catch(console.error);
