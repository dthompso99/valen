FROM gitea.hallrd.click/dthompson/valen-builder:ad7dd0017466e1e064635570d5474eafebfe97e2 AS build
WORKDIR /source
COPY lib ./lib
COPY examples/clippy ./examples/clippy
ENV VALEN_LIBRARY_PATH=/source/lib
RUN /app/valen examples/clippy/server.ar -o /clippy

FROM scratch
COPY --from=build /clippy /clippy
USER 65532:65532
ENV PORT=3000
ENV VALEN_MAX_MESSAGE_BYTES=104857600
EXPOSE 3000
ENTRYPOINT ["/clippy"]
