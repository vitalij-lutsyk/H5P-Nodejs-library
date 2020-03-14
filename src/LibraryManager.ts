import { ReadStream } from 'fs';
import fsExtra from 'fs-extra';
import globPromise from 'glob-promise';
import path from 'path';
import { Stream } from 'stream';

import H5pError from './helpers/H5pError';
import Logger from './helpers/Logger';
import { streamToString } from './helpers/StreamHelpers';
import InstalledLibrary from './InstalledLibrary';
import LibraryName from './LibraryName';
import {
    IFullLibraryName,
    IInstalledLibrary,
    ILibraryFileUrlResolver,
    ILibraryInstallResult,
    ILibraryMetadata,
    ILibraryName,
    ILibraryStorage,
    IPath,
    ISemanticsEntry
} from './types';

const log = new Logger('LibraryManager');

/**
 * This class manages library installations, enumerating installed libraries etc.
 * It is storage agnostic and can be re-used in all implementations/plugins.
 */

export default class LibraryManager {
    /**
     *
     * @param libraryStorage The library repository that persists library somewhere.
     */
    constructor(
        private libraryStorage: ILibraryStorage,
        /**
         * Gets URLs at which a file in a library can be downloaded. Must be passed
         * through from the implementation.
         */
        private fileUrlResolver: ILibraryFileUrlResolver = (
            library,
            filename
        ) => '' // default is there to avoid having to pass empty function in tests
    ) {
        log.info('initialize');
    }

    /**
     * Returns a readable stream of a library file's contents.
     * Throws an exception if the file does not exist.
     * @param library library
     * @param filename the relative path inside the library
     * @returns a readable stream of the file's contents
     */
    public async getFileStream(
        library: ILibraryName,
        file: string
    ): Promise<ReadStream> {
        log.debug(
            `getting file ${file} from library ${LibraryName.toUberName(
                library
            )}`
        );
        return this.libraryStorage.getFileStream(library, file);
    }

    /**
     * Gets the language file for the specified language.
     * @param library
     * @param language the language code
     * @returns {Promise<any>} the decoded JSON data in the language file
     */
    public async getLanguage(
        library: ILibraryName,
        language: string
    ): Promise<any> {
        try {
            log.debug(
                `loading language ${language} for library ${LibraryName.toUberName(
                    library
                )}`
            );
            return await this.getJsonFile(
                library,
                path.join('language', `${language}.json`)
            );
        } catch (ignored) {
            log.debug(
                `language '${language}' not found for ${LibraryName.toUberName(
                    library
                )}`
            );
            return null;
        }
    }

    /**
     * Returns the information about the library that is contained in library.json.
     * @param library The library to get (machineName, majorVersion and minorVersion is enough)
     * @returns {Promise<ILibrary>} the decoded JSON data or undefined if library is not installed
     */
    public async getLibrary(library: ILibraryName): Promise<IInstalledLibrary> {
        try {
            log.debug(`loading library ${LibraryName.toUberName(library)}`);
            return this.libraryStorage.getLibrary(library);
        } catch (ignored) {
            log.warn(
                `library ${LibraryName.toUberName(library)} is not installed`
            );
            return undefined;
        }
    }

    /**
     * Returns a (relative) URL for a library file that can be used to hard-code
     * URLs of specific files if necessary. Avoid using this method when possible!
     * This method does NOT check if the file exists!
     * @param library the library for which the URL should be retrieved
     * @param file the filename inside the library (path)
     * @returns the URL of the file
     */
    public getLibraryFileUrl(library: ILibraryName, file: string): string {
        log.debug(
            `getting URL of file ${file} for library ${library.machineName}-${library.majorVersion}.${library.minorVersion}`
        );
        const url = this.fileUrlResolver(library, file);
        log.debug(`URL resolved to ${url}`);
        return url;
    }

    /**
     * Returns the content of semantics.json for the specified library.
     * @param library
     * @returns {Promise<any>} the content of semantics.json
     */
    public async getSemantics(
        library: ILibraryName
    ): Promise<ISemanticsEntry[]> {
        log.debug(
            `loading semantics for library ${LibraryName.toUberName(library)}`
        );
        return this.getJsonFile(library, 'semantics.json');
    }

    /**
     * Returns a URL of the upgrades script in the library
     * @param library the library whose upgrade script should be accessed
     * @returns the URL of upgrades.js. Null if there is no upgrades file.
     * (The null value can be passed back to the client.)
     */
    public async getUpgradesScriptPath(library: ILibraryName): Promise<string> {
        log.debug(
            `getting upgrades script for ${library.machineName}-${library.majorVersion}.${library.minorVersion}`
        );
        if (await this.libraryStorage.fileExists(library, 'upgrades.js')) {
            return this.getLibraryFileUrl(library, 'upgrades.js');
        }
        log.debug(`no upgrades script found.`);
        return null;
    }

    /**
     * Installs or updates a library from a temporary directory.
     * It does not delete the library files in the temporary directory.
     * The method does NOT validate the library! It must be validated before calling this method!
     * Throws an error if something went wrong and deletes the files already installed.
     * @param directory The path to the temporary directory that contains the library files (the root directory that includes library.json)
     * @returns a structure telling if a library was newly installed, updated or nothing happened (e.g. because there already is a newer patch version installed).
     */
    public async installFromDirectory(
        directory: string,
        restricted: boolean = false
    ): Promise<ILibraryInstallResult> {
        log.info(`installing from directory ${directory}`);
        const newLibraryMetadata: ILibraryMetadata = await fsExtra.readJSON(
            `${directory}/library.json`
        );
        const newVersion = {
            machineName: newLibraryMetadata.machineName,
            majorVersion: newLibraryMetadata.majorVersion,
            minorVersion: newLibraryMetadata.minorVersion,
            patchVersion: newLibraryMetadata.patchVersion
        };

        if (await this.libraryExists(newLibraryMetadata)) {
            // Check if library is already installed.
            let oldVersion: IFullLibraryName;
            if (
                // tslint:disable-next-line: no-conditional-assignment
                (oldVersion = await this.isPatchedLibrary(newLibraryMetadata))
            ) {
                // Update the library if it is only a patch of an existing library
                await this.updateLibrary(newLibraryMetadata, directory);
                return {
                    newVersion,
                    oldVersion,
                    type: 'patch'
                };
            }
            // Skip installation of library if it has already been installed and the library is no patch for it.
            return { type: 'none' };
        }
        // Install the library if it hasn't been installed before (treat different major/minor versions the same as a new library)
        await this.installLibrary(directory, newLibraryMetadata, restricted);
        return {
            newVersion,
            type: 'new'
        };
    }

    /**
     * Is the library a patched version of an existing library?
     * @param library The library the check
     * @returns the full library name of the already installed version if there is a patched version of an existing library, undefined otherwise
     */
    public async isPatchedLibrary(
        library: IFullLibraryName
    ): Promise<IFullLibraryName> {
        log.info(
            `checking if library ${LibraryName.toUberName(library)} is patched`
        );
        const wrappedLibraryInfos = await this.listInstalledLibraries([
            library.machineName
        ]);
        if (!wrappedLibraryInfos || !wrappedLibraryInfos[library.machineName]) {
            return undefined;
        }
        const libraryInfos = wrappedLibraryInfos[library.machineName];

        for (const lib of libraryInfos) {
            if (
                lib.majorVersion === library.majorVersion &&
                lib.minorVersion === library.minorVersion
            ) {
                if (lib.patchVersion < library.patchVersion) {
                    return {
                        machineName: lib.machineName,
                        majorVersion: lib.majorVersion,
                        minorVersion: lib.minorVersion,
                        patchVersion: lib.patchVersion
                    };
                }
                break;
            }
        }
        return undefined;
    }

    /**
     * Checks if a library was installed.
     * @param library the library to check
     * @returns true if the library has been installed
     */
    public async libraryExists(library: LibraryName): Promise<boolean> {
        return this.libraryStorage.libraryExists(library);
    }

    /**
     * Check if the library contains a file
     * @param library The library to check
     * @param filename
     * @return {Promise<boolean>} true if file exists in library, false otherwise
     */
    public async libraryFileExists(
        library: ILibraryName,
        filename: string
    ): Promise<boolean> {
        log.debug(
            `checking if file ${filename} exists for library ${LibraryName.toUberName(
                library
            )}`
        );
        return this.libraryStorage.fileExists(library, filename);
    }

    /**
     * Checks if the given library has a higher version than the highest installed version.
     * @param library Library to compare against the highest locally installed version.
     * @returns {Promise<boolean>} true if the passed library contains a version that is higher than the highest installed version, false otherwise
     */
    public async libraryHasUpgrade(
        library: IFullLibraryName
    ): Promise<boolean> {
        log.verbose(
            `checking if library ${library.machineName}-${library.majorVersion}.${library.minorVersion} has an upgrade`
        );
        const wrappedLibraryInfos = await this.listInstalledLibraries([
            library.machineName
        ]);
        if (!wrappedLibraryInfos || !wrappedLibraryInfos[library.machineName]) {
            return false;
        }
        const allInstalledLibsOfMachineName = wrappedLibraryInfos[
            library.machineName
        ].sort((a: any, b: any) => a.compareVersions(b));
        const highestLocalLibVersion =
            allInstalledLibsOfMachineName[
                allInstalledLibsOfMachineName.length - 1
            ];
        if (highestLocalLibVersion.compareVersions(library) < 0) {
            return true;
        }
        return false;
    }

    /**
     * Gets a list of files that exist in the library.
     * @param library the library for which the files should be listed
     * @return the files in the library including language files
     */
    public async listFiles(library: ILibraryName): Promise<string[]> {
        log.verbose(
            `listing files for library ${LibraryName.toUberName(library)}`
        );
        return this.libraryStorage.listFiles(library);
    }

    /**
     * Get a list of the currently installed libraries.
     * @param machineNames (if supplied) only return results for the machines names in the list
     * @returns {Promise<any>} An object which has properties with the existing library machine names. The properties'
     * values are arrays of Library objects, which represent the different versions installed of this library.
     */
    public async listInstalledLibraries(
        machineNames?: string[]
    ): Promise<{ [key: string]: IInstalledLibrary[] }> {
        log.verbose(`checking if libraries ${machineNames} are installed`);
        let libraries = await this.libraryStorage.getInstalledLibraryNames(
            ...machineNames
        );
        libraries = (
            await Promise.all(
                libraries.map(async libName => {
                    const installedLib = InstalledLibrary.fromName(libName);
                    const info = await this.getLibrary(libName);
                    installedLib.patchVersion = info.patchVersion;
                    installedLib.runnable = info.runnable;
                    installedLib.title = info.title;
                    return installedLib;
                })
            )
        ).sort((lib1, lib2) => lib1.compare(lib2));

        const returnObject = {};
        for (const library of libraries) {
            if (!returnObject[library.machineName]) {
                returnObject[library.machineName] = [];
            }
            returnObject[library.machineName].push(library);
        }
        return returnObject;
    }

    /**
     * Gets a list of translations that exist for this library.
     * @param library
     * @returns {Promise<string[]>} the language codes for translations of this library
     */
    public async listLanguages(library: ILibraryName): Promise<string[]> {
        try {
            log.verbose(
                `listing languages for library ${LibraryName.toUberName(
                    library
                )}`
            );
            const installedLanguages = await this.libraryStorage.getLanguages(
                library
            );
            // always include English as its the language of the semantics file
            if (!installedLanguages.includes('en')) {
                installedLanguages.push('en');
            }
            return installedLanguages;
        } catch (error) {
            log.warn(
                `no languages found for library ${LibraryName.toUberName(
                    library
                )}`
            );
            return [];
        }
    }

    /**
     * Checks (as far as possible) if all necessary files are present for the library to run properly.
     * @param library The library to check
     * @returns {Promise<boolean>} true if the library is ok. Throws errors if not.
     */
    private async checkConsistency(library: ILibraryName): Promise<boolean> {
        if (!(await this.libraryExists(library))) {
            log.error(
                `Error in library ${LibraryName.toUberName(
                    library
                )}: not installed.`
            );
            throw new H5pError('library-consistency-check-not-installed', {
                name: LibraryName.toUberName(library)
            });
        }

        let metadata: ILibraryMetadata;
        try {
            metadata = await this.libraryStorage.getLibrary(library);
        } catch (error) {
            throw new H5pError(
                'library-consistency-check-library-json-unreadable',
                {
                    message: error.message,
                    name: LibraryName.toUberName(library)
                }
            );
        }
        if (metadata.preloadedJs) {
            await this.checkFiles(
                library,
                metadata.preloadedJs.map((js: IPath) => js.path)
            );
        }
        if (metadata.preloadedCss) {
            await this.checkFiles(
                library,
                metadata.preloadedCss.map((css: IPath) => css.path)
            );
        }

        return true;
    }

    /**
     * Checks if all files in the list are present in the library.
     * @param library The library to check
     * @param requiredFiles The files (relative paths in the library) that must be present
     * @returns {Promise<boolean>} true if all dependencies are present. Throws an error if any are missing.
     */
    private async checkFiles(
        library: ILibraryName,
        requiredFiles: string[]
    ): Promise<boolean> {
        log.debug(
            `checking files ${requiredFiles.join(
                ', '
            )} for ${LibraryName.toUberName(library)}`
        );
        const missingFiles = (
            await Promise.all(
                requiredFiles.map(async (file: string) => {
                    return {
                        path: file,
                        status: await this.libraryStorage.fileExists(
                            library,
                            file
                        )
                    };
                })
            )
        )
            .filter((file: { status: boolean }) => !file.status)
            .map((file: { path: string }) => file.path);
        if (missingFiles.length > 0) {
            throw new H5pError('library-consistency-check-file-missing', {
                files: missingFiles,
                name: LibraryName.toUberName(library)
            });
        }
        return true;
    }

    /**
     * Copies all library files from a directory (excludes library.json) to the storage.
     * Throws errors if something went wrong.
     * @param fromDirectory The directory to copy from
     * @param libraryInfo the library object
     * @returns {Promise<void>}
     */
    private async copyLibraryFiles(
        fromDirectory: string,
        libraryInfo: ILibraryName
    ): Promise<void> {
        log.info(`copying library files from ${fromDirectory}`);
        const files: string[] = await globPromise(`${fromDirectory}/**/*.*`);
        await Promise.all(
            files.map((fileFullPath: string) => {
                const fileLocalPath: string = path.relative(
                    fromDirectory,
                    fileFullPath
                );
                if (fileLocalPath === 'library.json') {
                    return Promise.resolve(true);
                }
                const readStream: Stream = fsExtra.createReadStream(
                    fileFullPath
                );
                return this.libraryStorage.addFile(
                    libraryInfo,
                    fileLocalPath,
                    readStream
                );
            })
        );
    }

    /**
     * Gets the parsed contents of a library file that is JSON.
     * @param library
     * @param file
     * @returns {Promise<any|undefined>} The content or undefined if there was an error
     */
    private async getJsonFile(
        library: ILibraryName,
        file: string
    ): Promise<any> {
        log.silly(
            `loading ${file} for library ${LibraryName.toUberName(library)}`
        );
        const stream: Stream = await this.libraryStorage.getFileStream(
            library,
            file
        );
        const jsonString: string = await streamToString(stream);
        return JSON.parse(jsonString);
    }

    /**
     * Installs a library and rolls back changes if the library installation failed.
     * Throws errors if something went wrong.
     * @param fromDirectory the local directory to install from
     * @param libraryInfo the library object
     * @param libraryMetadata the library metadata
     * @param restricted true if the library can only be installed with a special permission
     * @returns {IInstalledLibrary} the library object (containing - among others - the id of the newly installed library)
     */
    private async installLibrary(
        fromDirectory: string,
        libraryMetadata: ILibraryMetadata,
        restricted: boolean
    ): Promise<IInstalledLibrary> {
        log.info(
            `installing library ${LibraryName.toUberName(
                libraryMetadata
            )} from ${fromDirectory}`
        );
        const newLibraryInfo = await this.libraryStorage.addLibrary(
            libraryMetadata,
            restricted
        );

        try {
            await this.copyLibraryFiles(fromDirectory, newLibraryInfo);
            await this.checkConsistency(libraryMetadata);
        } catch (error) {
            log.error(
                `There was a consistency error when installing library ${LibraryName.toUberName(
                    libraryMetadata
                )}. Reverting installation.`
            );
            await this.libraryStorage.deleteLibrary(libraryMetadata);
            throw error;
        }
        log.debug(
            `library ${LibraryName.toUberName(
                libraryMetadata
            )} successfully installed.`
        );
        return newLibraryInfo;
    }

    /**
     * Updates the library to a new version.
     * REMOVES THE LIBRARY IF THERE IS AN ERROR!!!
     * @param filesDirectory the path of the directory containing the library files to update to
     * @param library the library object
     * @param newLibraryMetadata the library metadata (library.json)
     */
    private async updateLibrary(
        newLibraryMetadata: ILibraryMetadata,
        filesDirectory: string
    ): Promise<any> {
        try {
            log.info(
                `updating library ${LibraryName.toUberName(
                    newLibraryMetadata
                )} in ${filesDirectory}`
            );
            await this.libraryStorage.updateLibrary(newLibraryMetadata);
            log.info(
                `clearing library ${LibraryName.toUberName(
                    newLibraryMetadata
                )} from files`
            );
            await this.libraryStorage.clearFiles(newLibraryMetadata);
            await this.copyLibraryFiles(filesDirectory, newLibraryMetadata);
            await this.checkConsistency(newLibraryMetadata);
        } catch (error) {
            log.error(error);
            log.info(
                `removing library ${LibraryName.toUberName(newLibraryMetadata)}`
            );
            await this.libraryStorage.deleteLibrary(newLibraryMetadata);
            throw error;
        }
    }
}
