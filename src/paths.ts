import { homedir } from 'node:os';
import { join } from 'node:path';

/** The CLI's own files live in ~/.clawshelf/cli/, outside every agent's skills folder. */
export const cliDir = () => join(homedir(), '.clawshelf', 'cli');
export const credentialsFile = () => join(cliDir(), 'credentials.json');
export const stateFile = () => join(cliDir(), 'installed.json');
export const stagingDir = () => join(cliDir(), 'staging');
export const backupsDir = () => join(cliDir(), 'backups');
