{
  description = "CodeGraph";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  };

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [
        "aarch64-darwin"
      ];

      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          nodejs = pkgs.nodejs_24;
        in
        {
          codegraph = pkgs.buildNpmPackage {
            pname = "codegraph";
            version = "1.0.1";

            src = ./.;

            inherit nodejs;
            npmDepsHash = "sha256-FdWAmkYKRVnztBF4Va6chOVLdH8DHNfDM2aobCIRsq4=";

            npmBuildScript = "build";

            installPhase = ''
              runHook preInstall

              mkdir -p "$out/lib/codegraph" "$out/bin"
              cp -R dist node_modules package.json "$out/lib/codegraph/"

              makeWrapper ${nodejs}/bin/node "$out/bin/codegraph" \
                --add-flags "--liftoff-only $out/lib/codegraph/dist/bin/codegraph.js"

              runHook postInstall
            '';

            nativeBuildInputs = [
              pkgs.makeWrapper
            ];

            meta = {
              description = "Local-first code intelligence for AI agents";
              homepage = "https://github.com/colbymchenry/codegraph";
              license = pkgs.lib.licenses.mit;
              mainProgram = "codegraph";
              platforms = [ "aarch64-darwin" ];
            };
          };

          default = self.packages.${system}.codegraph;
        });

      apps = forAllSystems (system: {
        codegraph = {
          type = "app";
          program = "${self.packages.${system}.codegraph}/bin/codegraph";
        };

        default = self.apps.${system}.codegraph;
      });

      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
            ];
          };
        });
    };
}
