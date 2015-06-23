'use strict';

var _ = require('underskore'),
	Adapter = require('./adapter'),
	composer = require('./composer'),
	types = require('./types');


/**
 * @param {String} table The name of the table
 * @param {Helenus} db The instance of Helenus used to create a model
 */

module.exports = function *(table, db) {

	var _columns = {},
		_keys = [];

	(yield Adapter('system', db.hosts).execute('select * from schema_columns where columnfamily_name = ? and keyspace_name = ?;', [table, db.keyspace])).rows.forEach(column => {
		_columns[column.column_name] = types[column.validator];
		['partition_key', 'clustering_key'].includes(column.type) && _keys.push(column.column_name);
	});

	/**
	 * @param {Object} data Data to initialize row instance with, column names as keys
	 */
	function Row(data, exists) {
		if (!(this instanceof Row))
			return new Row(data);

		this._data = exists ? data : {};
		this._exists = exists;
		_.extend(this, data);
	}

	_.extend(Row, {

		meta: {
			_columns,
			_keys
		},

		/**
		 * @param {Object} criteria [optional] The where clause criteria, including:
			column names as keys, and values as:
				value for exact match, or
				{Object} where:
					operators as keys and operands as values for numerical comparison,
					'in' as key and {Array} of values for in clause,
					'contains' or 'containsKey' as key and the respective value or key to check for in the set, list or map as value
		 * @param {Object} clauses [optional] Additional clauses such as:
			distinct: ['column1', 'column2'],
			count: true,
			orderBy: column_name for default (ascending), or {Object} with order (asc|desc) as key and column_name as value
			limit: 100,
			allowFiltering: true,
			raw: not wrapped in a Helenus object
		 * @param {Object} options [optional] Any other query options as defined in http://www.datastax.com/drivers/nodejs/2.0/global.html#QueryOptions
		 */

		*find(criteria = {}, clauses = {}, options = {}) {
			var params = [];

			var select = composer.select(clauses),
				from = composer.from(table),
				where = composer.where(criteria, params),
				order = composer.order(clauses),
				limit = composer.limit(clauses, params),
				filtering = composer.filtering(clauses);

			var query = select + from + where + order + limit + filtering + ';';

			var raw = yield db.adapter.execute(query, params, options);

			if (clauses.raw)
				return _.extend(raw.rows, raw);

			return _.extend(raw.rows.map(row => new Row(row, true)), raw);
		}

	});

	_.extend(Row.prototype, {

		/**
		 * @param {Object} clauses [optional] 'ttl' and / or 'timestamp' for the row being saved
		 */
		*save(clauses = {}) {
			this._validate();
			return yield this[this._exists ? '_update' : '_insert'](this._getData(), clauses);
		},

		/**
		 * @param {Number} by [optional] the amount to increment the counter by, assumed 1 if not given
		 * @param {String} column [optional] the specific counter column to increment, not required if there's only one such column
		 */
		*increment(by = 1, column = _.findKey(_columns, type => type === 'counter')) {
			this._validate();

			var params = [];

			var update = composer.update(table),
				increment = composer.increment(column, by),
				where = this._where(params);

			var query = update + increment + where;

			yield db.adapter.execute(query, params);

			return this;
		},

		/**
		 * @param {String} column [optional] the specific counter column to decrement, not required if there's only one such column
		 * @param {Number} by [optional] the amount to decrement the counter by, assumed 1 if not given
		 */
		*decrement(column = _.findKey(_columns, type => type === 'counter'), by = 1) {
			this._validate();

			var params = [];

			var update = composer.update(table),
				decrement = composer.decrement(column, by),
				where = this._where(params);

			var query = update + decrement + where;

			yield db.adapter.execute(query, params);

			return this;
		},

		/**
		 * @param {Array} columns [optional] If provided, the values from the given columns will be deleted; otherwise, the row will be deleted
		 */
		*delete(columns) {
			if (_.difference(columns, _columns).length)
				throw new Error('trying to delete columns that don\'t exist in the table: ' + columns.join(', '));

			this._validate();

			var params = [];

			var del = composer.delete(columns || []),
				from = composer.from(table),
				where = this._where(params);

			var query = del + from + where;

			yield db.adapter.execute(query, params);

			return this;
		},

		_where(params) {
			var criteria = _.pick(this, _keys);
			return composer.where(criteria, params);
		},

		*_insert(data, clauses = {}) {
			var params = [];

			var insert = composer.insert(table),
				values = composer.values(data, params),
				using = composer.using(clauses, params);

			var query = insert + values + using;

			yield db.adapter.execute(query, params);

			this._exists = true;
			this._data = data;

			return this;
		},

		*_update(data, clauses = {}) {
			var params = [];

			var update = composer.update(table),
				using = composer.using(clauses, params),
				set = composer.set(data, params),
				where = this._where(params);

			var query = update + using + set + where;

			yield db.adapter.execute(query, params);

			this._data = data;

			return this;
		},

		_getData() {
			return _(this).chain()
					.pick(_.keys(_columns))
					.omit(v => v === undefined)
					.delta(this._data)
					.value();
		},

		_validate() {
			// do keys exist?
			_keys.forEach(key => {
				if (!this.hasOwnProperty(key))
					throw new Error('part of primary key ' + key + ' missing');
			}, this);

			// type validations inbuilt into cassandra-driver
		}

	});

	return Row;
};
