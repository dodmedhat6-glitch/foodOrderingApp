/** @type {import('jest').Config} */
const swcOptions = {
  jsc: {
    target: 'es2022',
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
  },
};

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/unit'],
  testMatch: ['**/*.test.ts'],
  setupFiles: ['<rootDir>/tests/setup.env.ts', '<rootDir>/jest.setup.ts'],
  // Sources use NodeNext-style '.js' specifiers that resolve to '.ts' sources.
  resolver: '<rootDir>/jest.resolver.js',
  transform: {
    '^.+\\.tsx?$': ['@swc/jest', swcOptions],
    // uuid v14 ships ESM only; let swc down-level it to CommonJS.
    '^.+\\.m?jsx?$': [
      '@swc/jest',
      {
        module: { type: 'commonjs' },
        jsc: { target: 'es2022', parser: { syntax: 'ecmascript' } },
      },
    ],
  },
  transformIgnorePatterns: ['/node_modules/(?!uuid/)'],
};
