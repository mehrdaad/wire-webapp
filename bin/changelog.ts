import fs from 'fs-extra';
import Changelog from 'generate-changelog';
import path from 'path';

import * as pkg from '../package.json';

const simpleGit = require('simple-git')();

const options: {} = {'--list': null};
simpleGit.tags(
  options,
  async (
    error: Error,
    tags: {
      all: string[];
    },
  ) => {
    const outputPath = path.join(__dirname, '../CHANGELOG.md');
    const productionTags = tags.all.filter(tag => tag.includes('-production.'));
    const latestProductionTag = productionTags.sort().reverse()[0];
    const changelog = await Changelog.generate({
      exclude: ['chore', 'docs', 'refactor', 'style', 'test'],
      repoUrl: pkg.repository.url.replace('.git', ''),
      tag: `${latestProductionTag}...master`,
    });
    console.info(`Changelog size: ${changelog.length}`);
    fs.outputFileSync(outputPath, changelog, 'utf8');
    console.info(`Wrote file to: ${outputPath}`);
  },
);
