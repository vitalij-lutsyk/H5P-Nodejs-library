import * as fsExtra from 'fs-extra';
import jsonpath from 'jsonpath';
import * as path from 'path';
import { dir, DirectoryResult } from 'tmp-promise';

import { ContentFileScanner } from '../../src/ContentFileScanner';
import ContentManager from '../../src/ContentManager';
import EditorConfig from '../../src/implementation/EditorConfig';
import FileContentStorage from '../../src/implementation/fs/FileContentStorage';
import FileLibraryStorage from '../../src/implementation/fs/FileLibraryStorage';
import LibraryManager from '../../src/LibraryManager';
import PackageImporter from '../../src/PackageImporter';
import { ContentId } from '../../src/types';

import User from '../../examples/User';

import { getContentDetails } from '../ContentScanner.test';

describe('ContentFileScanner (integration test with H5P Hub examples)', () => {
    // scan all Hub examples for their file references and compare to directory contents
    const directory = path.resolve('test/data/hub-content/');
    let h5pPackages;
    try {
        h5pPackages = fsExtra.readdirSync(directory);
    } catch {
        throw new Error(
            "The directory test/data/hub-content does not exist. Execute 'npm run download:content' to fetch example data from the H5P Hub!"
        );
    }

    // Install all packages from the H5P Hub before running tests for indidual content.
    // (This is necessary, as some packages have unfulfilled dependencies if you just install them. The
    // tests for these packages will fail because the semantics.json file is missing for them.)

    let tmpDir: DirectoryResult;
    let tmpDirPath: string;
    let contentManager: ContentManager;
    let contentScanner: ContentFileScanner = null;
    let packageIdMap: Map<string, ContentId>;
    const user = new User();
    user.canUpdateAndInstallLibraries = true;

    // We have to use beforeAll as describe(...) doesn't accept async functions
    beforeAll(async done => {
        tmpDir = await dir({ unsafeCleanup: true });
        tmpDirPath = tmpDir.path;

        // create required dependencies
        const contentDir = path.join(tmpDirPath, 'content');
        const libraryDir = path.join(tmpDirPath, 'libraries');
        await fsExtra.ensureDir(contentDir);
        await fsExtra.ensureDir(libraryDir);

        contentManager = new ContentManager(new FileContentStorage(contentDir));
        const libraryManager = new LibraryManager(
            new FileLibraryStorage(libraryDir)
        );

        // install content & libraries
        const packageImporter = new PackageImporter(
            libraryManager,
            new EditorConfig(null),
            contentManager
        );

        packageIdMap = new Map<string, ContentId>();

        for (const file of h5pPackages.filter(f => f.endsWith('.h5p'))) {
            packageIdMap.set(
                file,
                (
                    await packageImporter.addPackageLibrariesAndContent(
                        path.join(directory, file),
                        user
                    )
                ).id
            );
        }

        contentScanner = new ContentFileScanner(libraryManager);
        done();
    }, 120000); // long timeout because we install a lot of packages

    afterAll(async () => {
        tmpDir.cleanup();
    });

    for (const file of h5pPackages.filter(f => f.endsWith('.h5p'))) {
        it(`finds all files in ${file}`, async () => {
            const contentId = packageIdMap.get(file);

            const { params, mainLibraryName } = await getContentDetails(
                contentId,
                user,
                contentManager
            );

            const foundFiles = await contentScanner.scanForFiles(
                params,
                mainLibraryName
            );

            const fileSystemFiles = await contentManager.getContentFiles(
                contentId,
                user
            );

            expect(
                foundFiles.map(f => path.normalize(f.filePath)).sort()
            ).toEqual(fileSystemFiles.map(p => path.normalize(p)).sort());

            const parameters = await contentManager.loadContent(
                contentId,
                user
            );
            for (const foundFile of foundFiles) {
                const queryResult = jsonpath.query(
                    parameters,
                    foundFile.context.jsonPath
                )[0];
                expect(queryResult).toBeDefined();
                expect(queryResult.path).toEqual(
                    // for some reason there seems to be some #tmp remnant in the examples, so we have
                    // to add the temporary file marked for these cases
                    `${foundFile.filePath}${foundFile.temporary ? '#tmp' : ''}`
                );
            }
        });
    }
});
