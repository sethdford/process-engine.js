var util = require('util');
var EventEmitter = require('events').EventEmitter;
var _ = require('lodash');
_.str = require('underscore.string');
_.mixin(_.str.exports());
var Promise = require("bluebird");
var debug = require('debug')('process-engine');

var ProcessEngine = require('./process-engine.js');
var ProcessDefinition = require('./process-definition.js');
var processBuilder = ProcessDefinition.processBuilder;
var Task = ProcessDefinition.Task;
var ServiceTask = ProcessDefinition.ServiceTask;
var Decision = ProcessDefinition.Decision;

/**
 * [CORE] The graph structure to hold the runtime process execution state
 * @param {[Task]} task
 * @param {[ProcessInstance]} processInstance
 */
function Node(task, processInstance) {
  Node.super_.apply(this, arguments);
  this.task = task;
  this.processInstance = processInstance;
  this.incomingFlowCompletedNumber = 0;
}
util.inherits(Node, EventEmitter);

/**
 * The method is called when this node is ready to execute
 */
Node.prototype.execute = function () {
  this.processInstance.emit('before', this.task);
  this.executeInternal(this.complete.bind(this));
};

/**
 * The subclass needs to override this method
 * @param  {[function]} complete
 */
Node.prototype.executeInternal = function (complete) {
  complete();
};

/**
 * called before transition
 * @return {[Boolean]} whether we are allowed to follow outgoing flows
 */
Node.prototype.canFollowOutgoingFlow = function (flow) {
  return true;
};

/**
 * called before execution of the node
 * @param  {[Node]} node
 * @return {[Boolean]}
 */
Node.prototype.canExecuteNode = function () {
  return this.incomingFlowCompletedNumber === this.task.incomingFlows.length;
};

/**
 * The method is called when the node execution is done
 */
Node.prototype.complete = function (err, variables) {
  if (err) {
    return this.processInstance.changeStatus(ProcessInstance.STATUS.FAILED, err).bind(this).done(function () {
      this.processInstance.emit('end');
    });
  }
  if (variables)
    this.processInstance.variables = _.clone(variables, true);
  this.processInstance.emit('after', this.task);
  delete this.processInstance.nodePool[this.task.id];

  // Follow outgoing flows
  this.task.outgoingFlows.forEach(function (flow) {
    if (!this.canFollowOutgoingFlow(flow))
      return;

    var node;
    if (this.processInstance.nodePool[flow.to.id]) {
      node = this.processInstance.nodePool[flow.to.id];
    }
    else {
      node = this.processInstance.createNode(flow.to);
      this.processInstance.nodePool[flow.to.id] = node;
    }
    node.incomingFlowCompletedNumber++;

    // Need to decide whether to execute next node
    if (node.canExecuteNode()) {
      node.execute();
    } else {
      // If Process instance status has been suspended, need to save again because it's possile that
      // an async service task is started before the instance is suspended
      if (this.processInstance.status === ProcessInstance.STATUS.WAITING)
        this.processInstance.save().done();
    }
  }.bind(this));

  if (this.task.type === 'end-task') {
    this.processInstance.changeStatus(ProcessInstance.STATUS.COMPLETED).done(function () {
      this.processInstance.emit('end');
    }.bind(this));
  }
};

Node.prototype.serialize = function () {
  var entity = {
    processInstance: this.processInstance.id,
    incomingFlowCompletedNumber: this.incomingFlowCompletedNumber,
    task: this.task.id
  };
  return entity;
};

Node.prototype.deserialize = function (entity) {
};

/**
 * The factory method to deserialize node
 * @param  {[Entity]} entity
 * @param  {[ProcessInstance]} instance
 * @return {[Node]}
 */
Node.deserialize = function (entity, instance) {
  var task = instance.def.tasks[entity.task];
  var node = instance.createNode(task);
  node.processInstance = instance;
  node.task = task;
  node.deserialize();
  return node;
};

var engineAPI = {
  createProcessInstance: function (def) {
    var processInstance = new ProcessInstance(def);
    processInstance.id = this.nextProcessId++;
    this.processPool[processInstance.id] = processInstance;
    return processInstance;
  },

  completeTask: Promise.method(function (processId, taskId, variables) {
    debug('Complete', processId, taskId);
    if (!this.processPool[processId]) {
      return this.loadProcessInstance(processId).done(function (instance) {
        this.processPool[processId].nodePool[taskId].complete(null, variables);
      }.bind(this));
    }
    else
      return this.processPool[processId].nodePool[taskId].complete(null, variables);
  }),

  loadProcessInstance: Promise.method(function (id) {
    if (this.processPool[id])
      return this.processPool[id];
    debug('loading instance: %s', id);
    return this.instanceCollection.findOneAsync({id: id}).bind(this).then(function (entity) {
      debug('Load:', entity);
      if (!entity) return;
      return ProcessInstance.deserialize(this, entity);
    }).then(function (instance) {
      if (instance)
        this.processPool[instance.id] = instance;
      return instance;
    });
  }),

  queryProcessInstances: function (conditions) {
    return this.instanceCollection.findAsync(conditions);
  },

  clearPool: function () {
    _.forOwn(this.processPool, function (instance, key) {
      if (instance.status === ProcessInstance.STATUS.WAITING || instance.status === ProcessInstance.STATUS.COMPLETED)
        delete this.processPool[key];
    }.bind(this));
  }
};


/**
 * [CORE] A execution of a particular process definition
 */
function ProcessInstance(def) {
  ProcessInstance.super_.apply(this, arguments);
  this.engine = def.engine;
  this.id = null;
  this.def = def;
  // The active node instances (key: task id)
  this.nodePool = {};
  this.status = ProcessInstance.STATUS.NEW;
  this.variables = {};
  this.error = null;
}
util.inherits(ProcessInstance, EventEmitter);

ProcessInstance.STATUS = {NEW: 'New', RUNNING: 'Running', WAITING: 'Waiting', COMPLETED: 'Completed', FAILED: 'Failed'};

ProcessInstance.prototype.createNode = function (task) {
  var taskType = this.engine.taskTypes[task.type];
  if (!taskType)
    node = new Node(task, this);
  else
    node = new taskType[1](task, this);
  return node;
};

ProcessInstance.prototype.getNode = function (taskName) {
  for (var key in this.nodePool) {
    if (this.nodePool[key].task.name === taskName)
      return this.nodePool[key];
  }
};

ProcessInstance.prototype._start = function (variables) {
  this.variables = variables || this.def.variables;
  return this.changeStatus(ProcessInstance.STATUS.RUNNING).done(function () {
    var node = new Node(this.def.tasks[0], this);
    node.execute();
  }.bind(this));
};

/**
 * Start the process instance with variables
 * If the process definition is not saved, just save it right now
 * @param  {[type]} variables [description]
 * @return {[type]}           [description]
 */
ProcessInstance.prototype.start = function (variables) {
  if (!this.def._id)
    this.def.save().done(function(def) {
      this.def._id = def._id;
      this._start(variables);
    }.bind(this));
  else
    this._start(variables);
};

/**
 * @return {Promise}
 */
ProcessInstance.prototype.changeStatus = function (status, err) {
  this.status = status;
  this.error = err;
  return this.save();
};

ProcessInstance.prototype.save = function () {
  var entity = this.serialize();
  if (entity._id)
    return this.engine.instanceCollection.updateAsync({'_id': entity._id}, entity, {}).then(function () {
      return entity;
    });
  else
    return this.engine.instanceCollection.insertAsync(entity).then(function (entity) {
      this._id = entity._id;
      return this;
    }.bind(this));
};

ProcessInstance.prototype.serialize = function () {
  var serializeNodePool = function() {
    var serializedNodes = [];
    _.forOwn(this.nodePool, function (node) {
      serializedNodes.push(node.serialize());
    }, this);
    return serializedNodes;
  }.bind(this);

  var entity = {
    _id: this._id,
    id: this.id,
    def: this.def._id,
    status: this.status,
    nodePool: serializeNodePool(),
    variables: this.variables,
    error: this.error
  };
  return entity;
};

/**
 * @return {[Promise]}
 */
ProcessInstance.deserialize = function (engine, entity) {
  return engine.loadProcessDefinition(entity.def).then(function (def) {
    var instance = new ProcessInstance(def);
    instance.id = entity.id;
    instance.status = entity.status;
    instance.variables = entity.variables;
    instance.error = entity.error;
    entity.nodePool.forEach(function (entity) {
      var node = Node.deserialize(entity, instance);
      instance.nodePool[node.task.id] = node;
    });

    return instance;
  });
};


/**
 * CMD Export
 */
module.exports = {
  Instance: ProcessInstance,
  Node: Node,
  API: engineAPI
};

