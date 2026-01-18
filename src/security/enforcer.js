const rules = require('./rules');

class Enforcer {
  
  getRules(collection) {
    return rules[collection] || rules['*'];
  }

  async enforceList(collection, user) {
    if (user?.isAdmin) return {};

    const ruleSet = this.getRules(collection);
    const rule = ruleSet.list;
    
    if (!rule) return {};

    const result = rule(user);
    
    if (result === false) {
      throw new Error('Forbidden: Access denied to list this collection');
    }
    
    if (result === true) return {};
    
    return result;
  }

  async enforceSingle(action, collection, user, record) {
    if (user?.isAdmin) return true;

    const ruleSet = this.getRules(collection);
    const rule = ruleSet[action];

    if (!rule) return true;

    const allowed = rule(user, record);
    
    if (!allowed) {
      throw new Error(`Forbidden: You cannot ${action} this record`);
    }
  }
}

module.exports = new Enforcer();