const path = require("path");
const SwaggerParser = require("swagger-parser");
const spinner = require("../../utils/spinner");
const buildApiFromSwagger = require("../adidas/buildFromSwagger");
const modifyValues = require("../adidas/modifyValues");
const confirmChanges = require("../../utils/confirmChanges");
const createApi = require("../../mashery/createApi");
const dumpApi = require("../../mashery/dumpApi");
const mergeApi = require("../../mashery/mergeApi")
const updateApi = require("../../mashery/updateApi");

function createFromSwagger(api, swagger) {
  return confirmChanges({
    before: {},
    after: api,
    message: `Are this valid new api from swagger \'${swagger}\'?`,
    action(newApi) {
      spinner.start();
      return createApi(newApi);
    }
  }).then(newService => {
    spinner.stop();
    console.log("Creating api from swagger done");
    console.log(`Service id=${newService.id}`);
  });
}

function updateFromSwagger(api, serviceId, swagger) {
  spinner.start();

  return dumpApi(serviceId)
    .then(dumpedApi => {
      spinner.stop();
      return confirmChanges({
        before: dumpedApi,
        after: mergeApi(api, dumpedApi),
        message: `Are this valid updates to service '${serviceId}' from swagger '${swagger}'?`,
        action(updatedApi) {
          spinner.start();
          return updateApi(serviceId, updatedApi);
        }
      });
    })
    .then(() => {
      spinner.stop();
      console.log("Updating api from swagger done");
    });
}

function importSwaggerFile(swagger, options) {
  SwaggerParser.parse(swagger)
    .then(swaggerData => {
      const apiFromSwagger = buildApiFromSwagger(swaggerData, options);
      const newApi = modifyValues(apiFromSwagger, options);

      const updateServiceId = options.update;
      return updateServiceId
        ? updateFromSwagger(newApi, updateServiceId, swagger)
        : createFromSwagger(newApi, swagger);
    })
    .catch(error => {
      spinner.stop();
      console.error("Creating failed:");
      console.error(error);
    });
}

module.exports = importSwaggerFile;