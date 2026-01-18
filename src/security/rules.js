/**
 * Row-Level Security Rules
 * Define quién puede hacer qué en cada colección
 */
module.exports = {
  
  // Reglas por defecto para colecciones no definidas
  '*': {
    list: (user) => (user ? {} : false),
    view: (user, record) => true,
    create: (user) => !!user,
    update: (user, record) => user && user.id === record.owner_id,
    delete: (user, record) => user && user.id === record.owner_id
  },

  // Colección de usuarios
  'users': {
    list: (user) => (user ? { id: user.id } : false),
    view: (user, record) => user && user.id === record.id,
    create: () => true, // Registro público
    update: (user, record) => user && user.id === record.id,
    delete: (user, record) => user && user.id === record.id
  },
  
  // Superusuarios (bloqueado externamente)
  '_superusers': {
    list: () => false,
    view: () => false,
    create: () => false,
    update: () => false,
    delete: () => false
  },

  // Ejemplo: Colección de posts
  'posts': {
    list: (user) => ({}), // Todos pueden listar
    view: (user, record) => true, // Todos pueden ver
    create: (user) => !!user, // Solo usuarios autenticados
    update: (user, record) => user && user.id === record.owner_id,
    delete: (user, record) => user && user.id === record.owner_id
  }
};