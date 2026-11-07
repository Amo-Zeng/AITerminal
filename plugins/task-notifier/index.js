'use strict';
exports.activate = ctx => {
    const record = async event => ctx.ui.publish('latest', { type: 'text', title: ctx.config.prefix, text: JSON.stringify(event, null, 2) });
    ctx.events.on('task.completed', record);
    ctx.events.on('task.error', record);
    ctx.events.on('task.cancelled', record);
    ctx.tools.register('test', () => ctx.notifications.send({ event: 'task_completed', message: `${ctx.config.prefix}：Webhook 插件投递测试` }));
};
