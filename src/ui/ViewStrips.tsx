// The blend / plan / profile strips. Empty SVGs that `render.ts` draws into (by id); the controller
// overrides their viewBox heights at boot from the isometric-scale constants (LH/PH/WH in view.ts).
// React renders them once with the static placeholder viewBoxes and never reconciles their children.
export function ViewStrips() {
  return (
    <>
      <div className="viewstrip">
        <svg
          id="svgWeights"
          viewBox="0 0 1000 150"
          preserveAspectRatio="xMidYMid meet"
        />
      </div>
      <div className="viewstrip">
        <svg
          id="svgPlan"
          viewBox="0 0 1000 278"
          preserveAspectRatio="xMidYMid meet"
        />
      </div>
      <div className="viewstrip">
        <svg
          id="svgProfile"
          viewBox="0 0 1000 422.4"
          preserveAspectRatio="xMidYMid meet"
        />
      </div>
    </>
  );
}
