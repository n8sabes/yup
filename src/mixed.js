import has from 'lodash/has';

import { mixed as locale } from './locale';
import Condition from './Condition';
import runValidations from './util/runValidations';
import merge from './util/merge';
import isAbsent from './util/isAbsent';
import cloneDeep from './util/clone';
import createValidation from './util/createValidation';
import BadSet from './util/set';
import Ref from './Reference';

let notEmpty = value => !isAbsent(value);

function extractTestParams(name, message, test, useCallback) {
  var opts = name;

  if (typeof message === 'function') {
    test = message; message = locale.default; name = null;
  }

  if (typeof name === 'function') {
    test = name; message = locale.default; name = null;
  }

  if (typeof name === 'string' || name === null)
    opts = { name, test, message, useCallback, exclusive: false }

  if (typeof opts.test !== 'function')
    throw new TypeError('`test` is a required parameters')

  return opts
}

export default function SchemaType(options = {}){
  if ( !(this instanceof SchemaType))
    return new SchemaType()

  this._deps        = []
  this._conditions  = []
  this._options     = { abortEarly: true, recursive: true }
  this._exclusive   = Object.create(null)
  this._whitelist   = new BadSet()
  this._blacklist   = new BadSet()
  this.tests        = []
  this.transforms   = []

  this.withMutation(() => {
    this.typeError(locale.notType)
  })

  if (has(options, 'default'))
    this._defaultDefault = options.default

  this._type = options.type || 'mixed'
}

SchemaType.prototype = {

  __isYupSchema__: true,

  constructor: SchemaType,

  clone() {
    if (this._mutate)
      return this;

    return cloneDeep(this);
  },

  label(label) {
    var next = this.clone();
    next._label = label;
    return next;
  },

  meta(obj) {
    if (arguments.length === 0)
      return this._meta;

    var next = this.clone();
    next._meta = Object.assign(next._meta || {}, obj)
    return next;
  },

  withMutation(fn) {
    this._mutate = true
    let result = fn(this)
    this._mutate = false
    return result
  },

  concat(schema){
    if (!schema)
      return this

    if (schema._type !== this._type && this._type !== 'mixed')
      throw new TypeError(`You cannot \`concat()\` schema's of different types: ${this._type} and ${schema._type}`)
    var cloned = this.clone()
    var next = merge(this.clone(), schema.clone())

    // undefined isn't merged over, but is a valid value for default
    if (has(schema, '_default'))
      next._default = schema._default

    next.tests = cloned.tests;
    next._exclusive = cloned._exclusive;

    // manually add the new tests to ensure
    // the deduping logic is consistent
    schema.tests.forEach((fn) => {
      next = next.test(fn.TEST)
    });

    next._type = schema._type;

    return next
  },

  isType(v) {
    if( this._nullable && v === null) return true
    return !this._typeCheck || this._typeCheck(v)
  },

  resolve({ context, parent }) {
    if (this._conditions.length) {
      return this._conditions.reduce((schema, match) =>
        match.resolve(schema, match.getValue(parent, context)), this)
    }

    return this
  },

  cast(value, options = {}) {
    let resolvedSchema = this.resolve(options)
    let result = resolvedSchema._cast(value, options);

    if (
      value !== undefined &&
      options.assert !== false &&
      resolvedSchema.isType(result) !== true
    ) {
      let formattedValue = JSON.stringify(value);
      let formattedResult = JSON.stringify(result);
      throw new TypeError(
        `The value of ${options.path || 'field'} could not be cast to a value ` +
        `that satisfies the schema type: "${resolvedSchema._type}". \n\n` +
        `attempted value: ${JSON.stringify(value)} \n` +
        ((formattedResult !== formattedValue)
          ? `result of cast: ${JSON.stringify(result)}` : '')
      );
    }

    return result;
  },

  _cast(rawValue) {
    let value = rawValue === undefined ? rawValue
      : this.transforms.reduce(
          (value, fn) => fn.call(this, value, rawValue), rawValue)

    if (value === undefined && has(this, '_default')) {
      value = this.default()
    }

    return value
  },

  validate(value, options = {}, cb) {
    if (typeof options === 'function')
      cb = options, options = {}

    let schema = this.resolve(options)

    return nodeify(schema._validate(value, options), cb)
  },

  _validate(_value, options = {}) {
    let value  = _value;

    let isStrict = this._option('strict', options)
    let endEarly = this._option('abortEarly', options)

    let path = options.path
    let label = this._label

    if (!isStrict) {

      value = this._cast(value, { assert: false, ...options })
    }
    // value is cast, we can check if it meets type requirements
    let validationParams = { value, path, schema: this, options, label }
    let initialTests = []

    if (this._typeError)
      initialTests.push(this._typeError(validationParams));

    if (this._whitelistError)
      initialTests.push(this._whitelistError(validationParams));

    if (this._blacklistError)
      initialTests.push(this._blacklistError(validationParams));

    return runValidations({ validations: initialTests, endEarly, value, path })
      .then(value => runValidations({
        path,
        value,
        endEarly,
        validations: this.tests.map(fn => fn(validationParams)),
      }))
  },


  isValid(value, options, cb) {
    if (typeof options === 'function')
      cb = options, options = {}

    return nodeify(this
      .validate(value, options)
      .then(() => true)
      .catch(err => {
        if ( err.name === 'ValidationError')
          return false

        throw err
      }), cb)
    },

  getDefault({ context, parent }) {
    return this._resolve(context, parent).default()
  },

  default(def) {
    if (arguments.length === 0) {
      var defaultValue = has(this, '_default')
        ? this._default
        : this._defaultDefault

      return typeof defaultValue === 'function'
        ? defaultValue.call(this)
        : cloneDeep(defaultValue)
    }

    var next = this.clone()
    next._default = def
    return next
  },

  strict() {
    var next = this.clone()
    next._options.strict = true
    return next
  },

  required(msg) {
    return this.test(
      'required',
      msg || locale.required,
      notEmpty
    )
  },

  nullable(value) {
    var next = this.clone()
    next._nullable = value === false ? false : true
    return next
  },

  transform(fn) {
    var next = this.clone();
    next.transforms.push(fn)
    return next
  },

  /**
   * Adds a test function to the schema's queue of tests.
   * tests can be exclusive or non-exclusive.
   *
   * - exclusive tests, will replace any existing tests of the same name.
   * - non-exclusive: can be stacked
   *
   * If a non-exclusive test is added to a schema with an exclusive test of the same name
   * the exclusive test is removed and further tests of the same name will be stacked.
   *
   * If an exclusive test is added to a schema with non-exclusive tests of the same name
   * the previous tests are removed and further tests of the same name will replace each other.
   */
  test(name, message, test, useCallback) {
    let opts = extractTestParams(name, message, test, useCallback)
      , next = this.clone();

    let validate = createValidation(opts);

    let isExclusive = (
      opts.exclusive ||
      (opts.name && next._exclusive[opts.name] === true)
    )

    if (opts.exclusive && !opts.name) {
      throw new TypeError('Exclusive tests must provide a unique `name` identifying the test')
    }

    next._exclusive[opts.name] = !!opts.exclusive

    next.tests = next.tests
      .filter(fn => {
        if (fn.TEST_NAME === opts.name) {
          if (isExclusive) return false
          if (fn.TEST.test === validate.TEST.test) return false
        }
        return true
      })

    next.tests.push(validate)

    return next
  },

  when(keys, options) {
    var next = this.clone()
      , deps = [].concat(keys).map(key => new Ref(key));

    deps.forEach(dep => {
      if (!dep.isContext)
        next._deps.push(dep.key)
    })

    next._conditions.push(new Condition(deps, options))

    return next
  },

  typeError(message) {
    var next = this.clone()

    next._typeError = createValidation({
      name: 'typeError',
      message,
      test(value) {
        if (value !== undefined && !this.schema.isType(value))
          return this.createError({
            params: {
              type: this.schema._type
            }
          })
        return true
      }
    })
    return next
  },

  oneOf(enums, message = locale.oneOf) {
    var next = this.clone();

    enums.forEach(val => {
      next._blacklist.delete(val)
      next._whitelist.add(val)
    })

    next._whitelistError = createValidation({
      message,
      name: 'oneOf',
      test(value) {
        let valids = this.schema._whitelist
        if (valids.length && !(value === undefined || valids.has(value)))
          return this.createError({
            params: {
              values: valids.values().join(', ')
            }
          })
        return true
      }
    })

    return next
  },

  notOneOf(enums, message = locale.notOneOf) {
    var next = this.clone();

    enums.forEach( val => {
      next._whitelist.delete(val)
      next._blacklist.add(val)
    })

    next._blacklistError = createValidation({
      message,
      name: 'notOneOf',
      test(value) {
        let invalids = this.schema._blacklist
        if (invalids.length && invalids.has(value))
          return this.createError({
            params: {
              values: invalids.values().join(', ')
            }
          })
        return true
      }
    })

    return next
  },

  strip(strip = true) {
    let next = this.clone()
    next._strip = strip
    return next
  },

  _option(key, overrides){
    return has(overrides, key)
      ? overrides[key] : this._options[key]
  },

  describe() {
    let next = this.clone();

    return {
      type: next._type,
      meta: next._meta,
      label: next._label,
      tests: next.tests.map((fn) => fn.TEST_NAME, {})
    }
  }
}


let aliases = {
  oneOf: ['equals', 'is'],
  notOneOf: ['not', 'nope']
}

Object.keys(aliases).forEach(method => {
  aliases[method].forEach(alias =>
    SchemaType.prototype[alias] = SchemaType.prototype[method]
  )
})

function nodeify(promise, cb){
  if (typeof cb !== 'function') return promise

  promise.then(
    val => cb(null, val),
    err => cb(err)
  )
}
