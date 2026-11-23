import angular from "angular-eslint";

export default [
  ...angular.configs.templateRecommended.map((config) => ({ ...config, files: ["**/*.html"] })),
  ...angular.configs.templateAccessibility.map((config) => ({ ...config, files: ["**/*.html"] })),
];
