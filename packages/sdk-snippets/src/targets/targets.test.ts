/* eslint-disable mocha/no-setup-in-describe */
import type { Variables } from '..';
import type { ClientId, SnippetType, TargetId } from './targets';

import { readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

import chai, { expect } from 'chai';
import { jestSnapshotPlugin } from 'mocha-chai-jest-snapshot';

import { MetricsSDKSnippet } from '..';
import { availableWebhookTargets, extname } from '../helpers/utils';

chai.use(jestSnapshotPlugin());

const expectedBasePath = ['src', 'fixtures', 'webhooks'];

const inputFileNames = readdirSync(path.join(...expectedBasePath), 'utf-8');

const fixtures: [string, Variables][] = inputFileNames.map(inputFileName => [
  inputFileName.replace(path.extname(inputFileName), ''),
  // eslint-disable-next-line import/no-dynamic-require, global-require
  require(path.resolve(...expectedBasePath, inputFileName)),
]);

/** useful for debuggin, only run a particular set of targets */
const targetFilter: TargetId[] = [
  // put your targetId:
  // 'node',
];

/** useful for debuggin, only run a particular set of targets */
const clientFilter: ClientId[] = [
  // put your clientId here:
  // 'express',
];

/** useful for debuggin, only run a particular set of fixtures */
const fixtureFilter: string[] = [
  // put the name of the fixture file you want to isolate (excluding `.js`):
  // 'security-variables',
];

/**
 * This is useful when you want to make a change and overwrite it for every fixture.
 * Basically a snapshot reset.
 *
 * Switch to `true` in debug mode to put into effect.
 */
const OVERWRITE_EVERYTHING = Boolean(process.env.OVERWRITE_EVERYTHING) || false;

const testFilter =
  <T>(property: keyof T, list: T[keyof T][]) =>
  (item: T) =>
    list.length > 0 ? list.includes(item[property]) : true;

describe('webhooks', function () {
  availableWebhookTargets()
    .filter(testFilter('key', targetFilter))
    .forEach(({ key: targetId, title, clients }) => {
      const snippetType: SnippetType = 'webhooks';

      describe(`${title} snippet generation`, function () {
        clients.filter(testFilter('key', clientFilter)).forEach(({ key: clientId }) => {
          fixtures.filter(testFilter(0, fixtureFilter)).forEach(([fixture, variables]) => {
            const fixturePath = path.join(
              'src',
              'targets',
              targetId,
              clientId,
              snippetType,
              'fixtures',
              `${fixture}${extname(targetId)}`
            );

            let expectedOutput: string;
            try {
              expectedOutput = readFileSync(fixturePath).toString();
            } catch (err) {
              if (OVERWRITE_EVERYTHING) {
                writeFileSync(fixturePath, '');
                return;
              }
              throw new Error(
                `Missing a ${snippetType} test file for ${targetId}:${clientId} for the ${fixture} fixture.\nExpected to find the output fixture: \`/${fixturePath}\``
              );
            }

            const { convert } = new MetricsSDKSnippet(variables);
            const result = convert(snippetType, targetId, clientId);

            if (OVERWRITE_EVERYTHING && result) {
              writeFileSync(fixturePath, String(result.snippet));
              return;
            }

            it(`${clientId} request should match fixture for "${fixture}"`, function () {
              if (!result) {
                throw new Error(`Generated ${fixture} snippet for ${clientId} was \`false\``);
              }

              /*
               * This test is to make sure that our generated snippets
               * actually do any variable outputting vs being static
               */
              if (fixture !== 'empty') {
                expect(Object.keys(result.ranges).length).to.be.greaterThan(0);
              }

              expect(result.ranges).toMatchSnapshot();
              expect(result.snippet).to.deep.equal(expectedOutput);

              // This is making sure that there is an actual secret in the
              // generated output
              expect(result.snippet).to.match(/my-readme-secret/);
            });
          });
        });
      });
    });
});
