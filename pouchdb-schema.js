if (typeof module == 'object') module.exports = pouchSchema

function pouchSchema(pouchModel, microSecond, methods = {}) {

  //Common schema used by both drug and transaction dbs
  let drug = pouchModel()
    .ensure('_id').required().pattern(/\d{4}-\d{4}|\d{5}-\d{3}|\d{5}-\d{4}/)
    .ensure('form').required().typeString().pattern(/([A-Z][a-z]+\s?)+\b/)
    .ensure('generic').set(generic)
    .ensure('generics').required().typeArray().minLength(1).maxLength(10)
    .ensure('generics.name').required().typeString().pattern(/([A-Z][0-9a-z]*\s?)+\b/)
    .ensure('generics.strength').typeString().pattern(/^[0-9][0-9a-z/.]+$/)
    .ensure('price').default(doc => Object()).typeObject()
    .ensure('price.updatedAt').typeDateTime()
    .ensure('price.goodrx').typeNumber()
    .ensure('price.nadac').typeNumber()
    .ensure('brand').typeString().maxLength(20)
    .ensure('pkg').typeString().minLength(1).maxLength(2)

  //db specific schema
  let db = {

    drug:pouchModel()
      .ensure().rules(drug)
      .ensure('upc').set(doc => doc._id.replace('-', ''))
      .ensure('ndc9').set(ndc9)
      .ensure('labeler').typeString().maxLength(40)
      .ensure('warning').typeString()
      .ensure('updatedAt').set(_ => new Date().toJSON())
      .ensure('createdAt').default(_ => new Date().toJSON())
      .methods(methods.drug),

    user:pouchModel()
      .ensure('_id').set(doc => doc.phone.replace(/[^\d]/g, '')).typeTel()
      .ensure('phone').required().typeTel()
      .ensure('account._id').required().typeTel()
      .ensure('email').required().typeEmail()
      .ensure('name.first').required().typeString()
      .ensure('name.last').required().typeString()
      .ensure('updatedAt').set(_ => new Date().toJSON())
      .ensure('createdAt').default(_ => new Date().toJSON())
      .methods(methods.user),

    shipment:pouchModel()
      .ensure('_id').default(doc => doc.account.to._id+'.'+new Date().toJSON().slice(0, -5)+'.'+doc.account.from._id).typeString()
      .ensure('account.to.name').required().typeString()
      .ensure('account.to._id').required().typeTel()
      .ensure('account.from.name').required().typeString()
      .ensure('account.from._id').required().typeTel()
      .ensure('tracking').required().minLength(6)
      .ensure('updatedAt').set(doc => new Date().toJSON())
      .methods(methods.shipment),

    transaction:pouchModel()
      .ensure('_deleted')
        .custom(doc => ! doc.next.length)
        .withMessage('cannot delete because this transaction has references within its "next" property')
      .ensure('_id').default(transactionId).typeString()
      .ensure('drug').rules(drug)
      .ensure('user._id').required().typeTel()
      .ensure('shipment._id').required()
        .pattern(/^\d{10}$|^\d{10}\.\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{10}$/)
        .withMessage('must be a string in the format "account.from._id" or "account.from._id"."account.to._id"."new Date().toJSON()"')
      .ensure('verifiedAt').typeDateTime()
        .custom(doc => doc.qty.from || doc.qty.to).withMessage('cannot be set unless qty.from or qty.to is set')
        .custom(doc => doc.exp.from || doc.exp.to).withMessage('cannot be set unless exp.from or exp.to is set')
      .ensure('next').default(doc => []).typeArray()
        .custom(doc => ! doc.next.length || doc.verifiedAt)
        .withMessage('cannot contain any values unless transaction.verifiedAt is set')
      .ensure('next.qty').typeNumber()
      .ensure('qty').default(doc => Object()).typeObject()
      .ensure('qty.from').typeNumber().min(1).max(999)
      .ensure('qty.to').typeNumber().min(1).max(999)
      .ensure('exp').default(doc => Object()).typeObject()
      .ensure('exp.from').typeDateTime()
      .ensure('exp.to').typeDateTime()
      .ensure('bin').pattern(/[A-Z]\d{2,3}|UNIT/)
      .ensure('updatedAt').set(_ => new Date().toJSON())
      .methods(methods.transaction),

    account:pouchModel()
      .ensure('_id').set(doc => doc.phone.replace(/[^\d]/g, '')).typeTel()
      .ensure('phone').required().typeTel()
      .ensure('name').required().typeString()
      .ensure('license').required().typeString()
      .ensure('street').required().typeString()
      .ensure('city').required().typeString()
      .ensure('state').required().typeString().minLength(2).maxLength(2)
      .ensure('zip').required().pattern(/\d{5}/)
      .ensure('authorized').default(doc => []).typeArray()
      .ensure('ordered').default(doc => Object()).typeObject()
      .ensure('updatedAt').set(_ => new Date().toJSON())
      .ensure('createdAt').default(_ => new Date().toJSON())
      .methods(methods.account)
  }

  return db

  function ndc9(drug) {
    let [labeler, product] = drug._id.split('-')
    return ('00000'+labeler).slice(-5)+('0000'+product).slice(-4)
  }

  function generic(doc) {
    let drug = doc.drug || doc //used in both transaction.drug and drug
    let name = drug.generics.map(concat).join(', ')+' '+drug.form

    name = name.replace(/ tablet| capsule/i, '')

    return name

    function concat(generic) {
      return generic.name + (generic.strength && (" "+generic.strength))
    }
  }

  function transactionId() {
    return new Date().toJSON().replace('Z', microSecond()+'Z')
  }
}
