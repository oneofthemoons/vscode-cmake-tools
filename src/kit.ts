import * as vscode from 'vscode';
import * as path from 'path';

import * as proc from './proc';
import * as dirs from './dirs';
import {StateManager} from './state';
import {fs} from './pr';

/**
 * Base of all kits. Just has a name.
 */
export interface BaseKit { name: string; }

/**
 * CompilerKits list compilers for each language. This will be used on platforms
 * with GCC or Clang
 */
export interface CompilerKit extends BaseKit {
  type: 'compilerKit';
  compilers: {[lang: string] : string}
}

/**
 * VSKits are associated with an installed Visual Studio on the system, and a
 * target architecture.
 */
export interface VSKit extends BaseKit {
  type: 'vsKit';
  visualStudio: string;
  visualStudioArchitecture: string;
}

/**
 * ToolchainKits just name a CMake toolchain file to use when configuring.
 */
export interface ToolchainKit extends BaseKit {
  type: 'toolchainKit';
  toolchainFile: string;
}

/// Kits are a sum type of the above interface
export type Kit = CompilerKit | VSKit | ToolchainKit;

/**
 * Convert a binary (by path) to a CompilerKit. This checks if the named binary
 * is a GCC or Clang compiler and gets its version. If it is not a compiler,
 * returns null.
 * @param bin Path to a binary
 * @returns A CompilerKit, or null if `bin` is not a known compiler
 */
async function kitIfCompiler(bin: string):
    Promise<CompilerKit | null> {
      const fname = path.basename(bin);
      const gcc_regex = /^gcc(-\d+(\.\d+(\.\d+)?)?)?$/;
      const clang_regex = /^clang(-\d+(\.\d+(\.\d+)?)?)?$/;
      const gcc_res = gcc_regex.exec(fname);
      const clang_res = clang_regex.exec(fname);
      if (gcc_res) {
        const exec = await proc.execute(bin, [ '-v' ]);
        if (exec.retc != 0) {
          return null;
        }
        const last_line = exec.stderr.trim().split('\n').reverse()[0];
        const version_re = /^gcc version (.*?) .*/;
        const version_match = version_re.exec(last_line);
        if (version_match === null) {
          return null;
        }
        const version = version_match[1];
        const gxx_fname = fname.replace(/^gcc/, 'g++');
        const gxx_bin = path.join(path.dirname(bin), gxx_fname);
        const name = `GCC ${version}`;
        if (await fs.exists(gxx_bin)) {
          return {
            type : 'compilerKit',
            name : name,
            compilers : {
              'CXX' : gxx_bin,
              'C' : bin,
            }
          };
        } else {
          return {
            type : 'compilerKit',
            name : name,
            compilers : {
              'C' : bin,
            }
          };
        }
      } else if (clang_res) {
        const exec = await proc.execute(bin, [ '-v' ]);
        if (exec.retc != 0) {
          return null;
        }
        const first_line = exec.stderr.split('\n')[0];
        const version_re = /^clang version (.*?)-/;
        const version_match = version_re.exec(first_line);
        if (version_match === null) {
          return null;
        }
        const version = version_match[1];
        const clangxx_fname = fname.replace(/^clang/, 'clang++');
        const clangxx_bin = path.join(path.dirname(bin), clangxx_fname);
        const name = `Clang ${version}`;
        if (await fs.exists(clangxx_bin)) {
          return {
            type : 'compilerKit',
            name : name,
            compilers : {
              'C' : bin,
              'CXX' : clangxx_bin,
            },
          };
        } else {
          return {
            type : 'compilerKit',
            name : name,
            compilers : {
              'C' : bin,
            },
          };
        }
      } else {
        return null;
      }
    }

/**
 * Scans a directory for compiler binaries.
 * @param dir Directory containing candidate binaries
 * @returns A list of CompilerKits found
 */
async function scanDirForCompilerKits(dir: string) {
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) {
      console.log('Skipping scan of non-directory', dir);
      return [];
    }
  } catch (e) {
    if (e.code == 'ENOENT') {
      return [];
    }
    throw e;
  }
  const bins = (await fs.readdir(dir)).map(f => path.join(dir, f));
  // Scan each binary in parallel
  const prs = bins.map(async(bin) => {
    try {
      return await kitIfCompiler(bin)
    } catch (e) {
      // The binary may not be executable by this user...
      if (e.code == 'EACCES') {
        return null;
      }
      throw e;
    }
  });
  const maybe_kits = await Promise.all(prs);
  return maybe_kits.filter(k => k !== null) as Kit[];
}

/**
 * Search for Kits available on the platform.
 * @returns A list of Kits.
 */
async function
  scanForKits() {
  // Search directories on `PATH` for compiler binaries
  const pathvar = process.env['PATH'] !;
  const sep = process.platform === 'win32' ? ';' : ':';
  const paths = pathvar.split(sep);
  // Search them all in parallel
  const prs = paths.map(path => scanDirForCompilerKits(path));
  const arrays = await Promise.all(prs);
  const kits = ([] as Kit[]).concat(...arrays);
  kits.map(k => console.log(`Found kit ${k.name}`));
  return kits;
}

function _descriptionForKit(kit: Kit) {
  switch (kit.type) {
  case 'toolchainKit': {
    return `Kit for toolchain file ${kit.toolchainFile}`;
  }
  case 'vsKit': {
    return `Using compilers for ${kit.visualStudio} (${kit.visualStudioArchitecture} architecture)`;
  }
  case 'compilerKit': {
    return 'Using compilers: '
        + Object.keys(kit.compilers).map(k => `\n  ${k} = ${kit.compilers[k]}`);
  }
  }
}

export class KitManager implements vscode.Disposable {
  private _kits = [] as Kit[];
  private _kitsWatcher = vscode.workspace.createFileSystemWatcher(this._kitsPath);

  private _activeKitChangedEmitter = new vscode.EventEmitter<Kit | null>();
  readonly onActiveKitChanged = this._activeKitChangedEmitter.event;
  private _setActiveKit(kit: Kit | null) {
    if (kit) {
      this.stateManager.activeKitName = kit.name;
    } else {
      this.stateManager.activeKitName = null;
    }
    this._activeKitChangedEmitter.fire(kit);
  }

  // The status bar shows the currently selected kit, and allows the user
  // to select a new kit
  private _statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 3);

  constructor(readonly stateManager: StateManager) {
    // Re-read the kits file when it is changed
    this._kitsWatcher.onDidChange(_e => this._rereadKits());
    // Update the statusbar item whenever the active kit changes
    this.onActiveKitChanged(kit => {
      if (!kit) {
        this._statusItem.text = 'No Kit Selected';
      } else {
        this._statusItem.text = kit.name;
      }
    });
    // Clicking on it let's the user select a kit
    this._statusItem.command = 'cmake.selectKit';
    this._statusItem.show();
  }

  dispose() {
    this._kitsWatcher.dispose();
    this._activeKitChangedEmitter.dispose();
    this._statusItem.dispose();
  }

  private get _kitsPath(): string { return path.join(dirs.dataDir(), 'cmake-kits.json'); }

  async selectKit(): Promise<Kit | null> {
    interface KitItem extends vscode.QuickPickItem {
      kit: Kit
    }
    const items = this._kits.map((kit): KitItem => {
      return {
        label : kit.name,
        description : _descriptionForKit(kit),
        kit : kit,
      };
    });
    const chosen = await vscode.window.showQuickPick(items, {
      ignoreFocusOut : true,
      placeHolder : 'Select a Kit',
    });
    if (chosen === undefined) {
      // No selection was made
      return null;
    } else {
      this._setActiveKit(chosen.kit);
      return chosen.kit;
    }
  }

  async rescanForKits() {
    // clang-format off
    const old_kits_by_name = this._kits.reduce(
      (acc, kit) => Object.assign({}, acc, {[kit.name]: kit}),
      {} as{[kit: string]: Kit}
    );
    const discovered_kits = await scanForKits();
    const new_kits_by_name = discovered_kits.reduce(
      (acc, new_kit) => {
        acc[new_kit.name] = new_kit;
        return acc;
      },
      old_kits_by_name
    );
    // clang-format on

    const new_kits = Object.keys(new_kits_by_name).map(k => new_kits_by_name[k]);

    await fs.mkdir_p(path.dirname(this._kitsPath));
    const stripped_kits = new_kits.map((k: any) => {
      k.type = undefined;
      return k;
    });
    const sorted_kits = stripped_kits.sort((a, b) => {
      if (a.name == b.name) {
        return 0;
      } else if (a.name < b.name) {
        return -1;
      } else {
        return 1;
      }
    });
    await fs.writeFile(this._kitsPath, JSON.stringify(sorted_kits, null, 2));
  }

  private async _rereadKits() {
    const content_str = await fs.readFile(this._kitsPath);
    const content = JSON.parse(content_str.toLocaleString()) as object[];
    this._kits = content.map((item_): Kit => {
      if ('compilers' in item_) {
        const item = item_ as {
          name: string;
          compilers: {[lang: string] : string};
        };
        return {
          type : 'compilerKit',
          name : item.name,
          compilers : item['compilers'],
        };
      } else if ('toolchainFile' in item_) {
        const item = item_ as {
          name: string;
          toolchainFile: string;
        };
        return {
          type : 'toolchainKit',
          name : item.name,
          toolchainFile : item.toolchainFile,
        };
      } else if ('visualStudio' in item_) {
        const item = item_ as {
          name: string;
          visualStudio: string;
          visualStudioArchitecture: string;
        };
        return {
          type : 'vsKit',
          name : item.name,
          visualStudio : item.visualStudio,
          visualStudioArchitecture : item.visualStudioArchitecture,
        };
      } else {
        vscode.window.showErrorMessage(
            'Your cmake-kits.json file contains one or more invalid entries.');
        throw new Error('Invalid kits');
      }
    });
    // Set the current kit to the one we have named
    const already_active_kit
        = this._kits.find((kit) => kit.name === this.stateManager.activeKitName);
    this._setActiveKit(already_active_kit || null);
  }

  async initialize() {
    if (await fs.exists(this._kitsPath)) {
      // Load up the list of kits that we've saved
      await this._rereadKits();
    } else {
      await this.rescanForKits();
      interface DoOpen extends vscode.MessageItem {
        doOpen: boolean;
      }
      const item = await vscode.window.showInformationMessage<DoOpen>(
          'CMake Tools has scanned for available kits and saved them to a file. Would you like to edit the Kits file?',
          {},
          {title : "Yes", doOpen : true},
          {title : "No", isCloseAffordance : true, doOpen : false});
      if (item === undefined) {
        return;
      }
      if (item.doOpen) {
        this.openKitsEditor();
      }
    }
  }

  async openKitsEditor() {
    const text = await vscode.workspace.openTextDocument(this._kitsPath);
    return vscode.window.showTextDocument(text);
  }
}