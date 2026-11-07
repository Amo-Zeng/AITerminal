'use strict';
exports.activate = ctx => {
    ctx.models.register('configured', params => ctx.models.request({ ...params, ...(ctx.config.model ? { model: ctx.config.model } : {}), temperature: ctx.config.temperature }));
};
