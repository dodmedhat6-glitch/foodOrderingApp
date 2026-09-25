export const tokens = {
    // services
    AuthService : Symbol.for("AuthService"),
    UserService: Symbol.for("UserService"),
    RestaurantService: Symbol.for("RestaurantService"),
    BranchService: Symbol.for("BranchService"),
    MemberService: Symbol.for("MemberService"),
    ProductService: Symbol.for("ProductService"),
    CustomerAddressService: Symbol.for("CustomerAddressService"),
    PermissionCashService: Symbol.for("PermissionCashService"),

    // controllers
    AuthController: Symbol.for("AuthController"),
    UserController: Symbol.for("UserController"),
    RestaurantController: Symbol.for("RestaurantController"),
    BranchController: Symbol.for("BranchController"),
    MemberController: Symbol.for("MemberController"),
    ProductController: Symbol.for("ProductController"),
    CustomerAddressController: Symbol.for("CustomerAddressController"),
    PermissionCashController: Symbol.for("PermissionCashController"),

    //Lib/infra/
    Logger: Symbol.for("Logger"),

    // cache
    CacheProvider: Symbol.for("CacheProvider"),

    //email
    EmailProvider: Symbol.for("EmailProvider")
}