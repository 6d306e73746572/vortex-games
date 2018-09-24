/* 
  Mount & Blade games consist of 2 modTypes:
    - Entire module based mods which include a module.ini file.
    - Mods without a module.ini will be deployed to the native module
        folder based upon their file extension.
*/
const Promise = require('bluebird');
const path = require('path');
const Registry = require('winreg');
const { fs, util } = require('vortex-api');

// Mount and Blade module based mods have a module.ini
//  file. We can use this to find the root directory of the
//  mod regardless of archive folder structure.
const MAB_MODULE_FILE = 'module.ini';

// The common registry key path which can be used to
//  find the installation folder using the game's steam ID.
const steamReg = '\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App ';

// A map of file extensions mapped against their
//  expected folder name. ()
const MOD_EXT_DESTINATION = {
  '.dds': 'textures',
  '.brf': 'resource',
  '.sco': 'sceneobj',
  '.txt': '',
  // Music and sound override mods are currently not supported due to the fact
  //  that all sound extensions are used interchangeably between the Music and sound
  //  folders - this is making it hard to differentiate between the wanted destination
  //  folder, unless the mod creator places the files within the correct folders.

  //  TODO: Enhance extension to support correctly placed Sound/Music files.
  //'.mp3':
};

// Mount and blade game dictionary containing all
//  relevant information for game discovery.
const MAB_GAMES = {
  mountandblade: {
    id: 'mountandblade',
    name: 'Mount & Blade',
    steamId: '22100',
    regPath: steamReg + '22100',
    logo: 'gameart.png',
    exec: 'mount&blade.exe',
    nativeModuleName: 'native',
  },
  mbwarband: {
    id: 'mbwarband',
    name: 'Mount & Blade: Warband',
    steamId: '48700',
    regPath: steamReg + '48700',
    logo: 'gameartwarband.png',
    exec: 'mb_warband.exe',
    nativeModuleName: 'native',
  },
  mbwithfireandsword: {
    id: 'mbwithfireandsword',
    name: 'Mount & Blade: With Fire and Sword',
    steamId: '48720',
    regPath: steamReg + '48720',
    logo: 'gameartfire.png',
    exec: 'mb_wfas.exe',
    nativeModuleName: 'Ogniem i Mieczem',
  },
  // Not sure if Viking Conquest is a Warband mod or
  //  a standalone game ? Will keep this commented out
  //  until we can test it.
  //
  // vikingConquest: {
  //   id: 'mountandbladevikingconquest',
  //   name: 'Mount & Blade: Viking Conquest',
  //   steamId: '321300',
  //   regPath: steamReg + '321300',
  //   logo: 'gameartviking.png',
  //   exec: ?????
  // },
}

function findGame(mabGame) {
  const { name, regPath } = mabGame;
  if (Registry === undefined) {
    // linux ? macos ?
    return null;
  }

  let regKey = new Registry({
    hive: Registry.HKLM,
    key: regPath,
  });

  return new Promise((resolve, reject) => {
    regKey.get('InstallLocation', (err, result) => {
      if (err !== null) {
        reject(new Error(err.message));
      } else if (result === null) {
        reject(new Error('empty registry key'));
      } else {
        resolve(result.value);
      }
    });
  }).catch(err =>
    util.steam.findByName(name)
      .then(game => game.gamePath)
  );
}

function modPath(context, mabGame) {
  const state = context.api.store.getState();
  const modPath = path.join(state.settings.gameMode.discovered[mabGame.id].path, 'modules');
  return modPath;
}

function prepareForModding(discovery) {
    return fs.ensureDirAsync(path.join(discovery.path, 'modules'));
}

function main(context) {
  Object.keys(MAB_GAMES).map(key => {
    const mabGame = MAB_GAMES[key];
    context.registerGame({
      id: mabGame.id,
      name: mabGame.name,
      mergeMods: true,
      queryPath: () => findGame(mabGame),
      queryModPath: () => modPath(context, mabGame),
      logo: mabGame.logo,
      executable: () => mabGame.exec,
      requiredFiles: [
        mabGame.exec,
      ],
      details: {
        steamAppId: mabGame.steamId,
      },
      setup: prepareForModding,
    });
  });

  context.registerInstaller('mount-and-blade-mod', 25, testSupportedContent, installContent);

  return true;
}

function installContent(files,
                        destinationPath,
                        gameId,
                        progressDelegate) {
  let instructions;
  if (files.find((file => path.basename(file).toLowerCase() === MAB_MODULE_FILE)) !== undefined) {
    instructions = installModuleMod(files);
  } else if (files.find(file => path.extname(file).toLowerCase() in MOD_EXT_DESTINATION) !== undefined) {
    instructions = installOverrideMod(files, MAB_GAMES[gameId].nativeModuleName);
  }
  return Promise.resolve({instructions});
}

function testSupportedContent(files) {
  // Make sure we have a module.ini configuration file, or known overridable files within the archive.
  const supported = (files.find((file => path.basename(file).toLowerCase() === MAB_MODULE_FILE)) !== undefined) 
    || (files.find(file => path.extname(file).toLowerCase() in MOD_EXT_DESTINATION) !== undefined)
  return Promise.resolve({
    supported,
    requiredFiles: [],
  });
}

function installOverrideMod(files, nativeModuleName) {
  // We were not able to find a module.ini file; we will treat this as
  //  an override mod and place recognised file extensions in their expected
  //  directory.
  const instructions = files
    .filter(file => MOD_EXT_DESTINATION[path.extname(file).toLowerCase()] !== undefined)
    .map(file => {
      const fileType = path.extname(file).toLowerCase();
      let extFolder = MOD_EXT_DESTINATION[fileType];
      let finalDestination = path.join(nativeModuleName, extFolder, path.basename(file));

      return {
        type: 'copy',
        source: file,
        destination: finalDestination,
      };
    });

  return instructions;
}

function installModuleMod(files) {
  // We're going to assume that the folder where we find the module.ini file
  //  is the root directory of the module.
  //  - We're going to ignore any files that are outside the root directory.
  const filePath = path.dirname(files.find((file => path.basename(file).toLowerCase() === MAB_MODULE_FILE)));
  const splitPath = filePath.split(path.sep);
  const modRoot = splitPath[splitPath.length - 1];
  const instructions = files
    .filter(file => path.dirname(file) === filePath)
    .map(file => {
      // Is this file part of the module root dir ?
      if (file.indexOf(modRoot) !== -1) {
        // Remove all precedent folders up to the modRoot directory.
        //  this way we ensure we don't create huge pointless folder structures
        //  which the M&B game can't support.
        const finalDestination = file.substr(file.indexOf(modRoot));
        return {
          type: 'copy',
          source: file,
          destination: finalDestination,
        };
      }
    });

  return instructions;
}

module.exports = {
  default: main
};